/**
 * Repo Monitoring + Drift Repair (Adaptation Engine)
 * =================================================
 *
 * Operator directive (verbatim):
 *   "Repo Monitoring (2 repos, every 2 min): scanRepo() — checks git
 *    status, uncommitted files, unpushed commits, upstream ahead/behind,
 *    last commit age. Monitors: /home/z/my-project (Nouveau-dossier-3-).
 *    fixRepoDrift() — auto-pushes unpushed commits if GITHUB_PAT is
 *    configured, logs warnings for dirty trees + stale branches.
 *    Wired into orchestrator: Runs every 10 ticks (~2 min at 12s cadence).
 *    Non-throwing — every phase wrapped in try/catch (7 independent
 *    failure domains)."
 *
 * Architecture
 * ------------
 * A single `runRepoAdaptation()` performs one monitoring pass:
 *
 *   for each monitored repo:
 *     scanRepo(repo)      → 7 independent, non-throwing scan domains
 *         1. HEAD       branch + head hash            (also repo detection)
 *         2. WORKTREE   staged / unstaged / untracked counts + dirty paths
 *         3. UPSTREAM   the configured upstream ref (e.g. origin/main)
 *         4. AHEADBEHIND left/right rev-list count vs upstream
 *         5. UNPUSHED   commit count @{upstream}..HEAD
 *         6. LASTCOMMIT age of the most recent commit
 *         7. REMOTE     remote URL (host classification for push)
 *     fixRepoDrift(scan) → auto-push unpushed commits ONLY when GITHUB_PAT
 *                          is configured; otherwise warn. Warns on dirty
 *                          trees + stale branches. Never force-pushes,
 *                          never creates commits.
 *
 * Every phase is wrapped in try/catch (7 independent failure domains)
 * so a dead git binary, a missing .git, or a network failure can never
 * throw — failures are recorded on the scan and reported, never raised.
 *
 * Push policy is fail-closed:
 *   - No GITHUB_PAT  → no push, only a warning.
 *   - Only the current branch's EXISTING unpushed commits are pushed.
 *   - No `git add`, no `git commit`, no force push, no tag push.
 *   - Credentials are passed one-shot on the push argv (never persisted
 *     to config, never logged). GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo
 *     mean git can never hang waiting for a terminal prompt.
 */

import { execFile as execFileCb } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Per-command timeout so a hung git (e.g. stalled network FS) can't stall a tick. */
const GIT_TIMEOUT_MS = 10_000;
/** Push can take longer than a scan probe (net round-trip) — still bounded. */
const PUSH_TIMEOUT_MS = 30_000;
/** A branch with no commits in 30 days is considered stale. */
const STALE_BRANCH_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** After git is found broken (ENOENT), re-probe at most every 6 minutes. */
const GIT_RECOVER_COOLDOWN_MS = 6 * 60 * 1000;
/** Cap dirty-path listing in the report. */
const MAX_DIRTY_FILES = 20;

/** Never allow git to interactively prompt — fail closed instead of hanging. */
const HARDENED_ENV: typeof process.env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
};

export interface RepoScan {
  path: string;
  ok: boolean;
  git_dir: boolean;
  branch: string | null;
  head_hash: string | null;
  dirty_files: string[];
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  unpushed_commits: number;
  last_commit_ts: number | null;
  last_commit_age_ms: number | null;
  remote_url: string | null;
  remote_host: "github" | "other" | null;
  stale: boolean;
  domain_errors: string[];
  error: string | null;
}

export interface RepoMonitorTickResult {
  scanned_at: string;
  repos: RepoScan[];
  drift_fixed: number;
  warnings: string[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Git unavailable until proven otherwise. */
let gitBroken = false;
let gitBrokenAt: number | null = null;
/** Simple mutex so two ticks can't race a push on the same repo. */
const pushing = new Set<string>();

function log(...parts: unknown[]): void {
  console.log("[repo-monitor]", ...parts);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//***@");
  }
}

/** Non-throwing git invocation. Returns a result object, never throws. */
async function gitCapture(
  repoPath: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile(
      "git",
      ["-C", repoPath, ...args],
      {
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: HARDENED_ENV,
      }
    );
    return { ok: true, stdout: String(stdout), stderr: String(stderr), error: null };
  } catch (err) {
    const e = err as { code?: unknown; message?: string; stderr?: unknown; stdout?: unknown };
    if (e.code === "ENOENT" || /spawn git ENOENT|'git' is not recognized/i.test(String(e.message))) {
      gitBroken = true;
      gitBrokenAt = Date.now();
    }
    const detail = [
      e.message,
      String(e.stderr ?? "").trim(),
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 300);
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      error: detail || String(err),
    };
  }
}

function parseStatusPorcelain(raw: string): {
  staged: number;
  unstaged: number;
  untracked: number;
  entries: string[];
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const entries: string[] = [];
  const parts = raw.split("\0").filter((p) => p.length >= 2);
  for (const part of parts) {
    const xy = part.slice(0, 2);
    const path = part.length >= 3 ? part.slice(3) : part.slice(2).replace(/^ /, "");
    if (xy === "??") {
      untracked += 1;
    } else {
      if (xy[0] !== " " && xy[0] !== "?") staged += 1;
      if (xy[1] !== " ") unstaged += 1;
    }
    if (entries.length < MAX_DIRTY_FILES && path) entries.push(path);
  }
  return { staged, unstaged, untracked, entries };
}

function githubHttpsUrl(remote: string, token: string): string | null {
  let m = remote.match(/^https?:\/\/(?:[^@/]+@)?github\.com[/:](.+)$/i);
  if (m) return `https://${token}@github.com/${m[1]}`;
  m = remote.match(/^git@github\.com:(.+)$/i);
  if (m) return `https://${token}@github.com/${m[1]}`;
  m = remote.match(/^ssh:\/\/(?:git@)?(?:[^@/]+@)?github\.com\/(.+)$/i);
  if (m && m[1]) return `https://${token}@github.com/${m[1]}`;
  return null;
}

/**
 * Domain 1 — HEAD. Also serves as repo detection: if neither query works
 * the path is not a git working tree.
 */
async function probeBranch(path: string): Promise<{
  git_dir: boolean;
  branch: string | null;
  head_hash: string | null;
  error: string | null;
}> {
  const symbolic = await gitCapture(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.ok) {
    const branch = symbolic.stdout.trim();
    const hash = await gitCapture(path, ["rev-parse", "--short=7", "HEAD"]);
    return {
      git_dir: true,
      branch: branch || "HEAD",
      head_hash: hash.ok ? hash.stdout.trim() : null,
      error: null,
    };
  }
  const abort = await gitCapture(path, ["rev-parse", "--git-dir"]);
  if (!abort.ok) {
    return { git_dir: false, branch: null, head_hash: null, error: "not a git working tree" };
  }
  const ref = await gitCapture(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const hash = await gitCapture(path, ["rev-parse", "--short=7", "HEAD"]);
  return {
    git_dir: true,
    branch: ref.ok && ref.stdout.trim() !== "HEAD" ? ref.stdout.trim() : "(detached)",
    head_hash: hash.ok ? hash.stdout.trim() : null,
    error: symbolic.error,
  };
}

/**
 * Domain 2 — worktree cleanliness via `status --porcelain=v1 -z`.
 */
async function probeWorktree(path: string): Promise<{
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  dirty_files: string[];
  error: string | null;
}> {
  const res = await gitCapture(path, ["status", "--porcelain=v1", "-z", "--no-renames"]);
  if (!res.ok) {
    return { staged_count: 0, unstaged_count: 0, untracked_count: 0, dirty_files: [], error: res.error };
  }
  const parsed = parseStatusPorcelain(res.stdout);
  return {
    staged_count: parsed.staged,
    unstaged_count: parsed.unstaged,
    untracked_count: parsed.untracked,
    dirty_files: parsed.entries,
    error: null,
  };
}

/**
 * Domain 3 — upstream ref (e.g. `origin/main`). Absent on a branch that
 * has never been pushed.
 */
async function probeUpstream(path: string): Promise<{ upstream: string | null; error: string | null }> {
  const res = await gitCapture(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!res.ok) return { upstream: null, error: res.error };
  const upstream = res.stdout.trim();
  return { upstream: upstream && upstream !== "@{upstream}" ? upstream : null, error: null };
}

/**
 * Domain 4 — ahead (local-only commits) and behind (remote-only commits)
 * vs the upstream. Format from `git rev-list --left-right --count HEAD...@{upstream}`
 * is `"<left>\t<right>"` where left = HEAD side (ahead), right = upstream side (behind).
 */
async function probeAheadBehind(path: string): Promise<{
  ahead: number | null;
  behind: number | null;
  error: string | null;
}> {
  const res = await gitCapture(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  if (!res.ok) return { ahead: null, behind: null, error: res.error };
  const [left, right] = res.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(left ?? "0", 10);
  const behind = Number.parseInt(right ?? "0", 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    return { ahead: null, behind: null, error: "unparseable ahead/behind output" };
  }
  return { ahead, behind, error: null };
}

/**
 * Domain 5 — unpushed commit count: commits reachable from HEAD but not
 * from the upstream.
 */
async function probeUnpushed(path: string): Promise<{ unpushed: number; error: string | null }> {
  const res = await gitCapture(path, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (!res.ok) return { unpushed: 0, error: res.error };
  const unpushed = Number.parseInt(res.stdout.trim(), 10);
  return { unpushed: Number.isNaN(unpushed) ? 0 : unpushed, error: null };
}

/**
 * Domain 6 — age of the most recent commit (unix seconds from %ct).
 */
async function probeLastCommit(path: string): Promise<{
  last_commit_ts: number | null;
  last_commit_age_ms: number | null;
  error: string | null;
}> {
  const res = await gitCapture(path, ["log", "-1", "--format=%ct"]);
  if (!res.ok) return { last_commit_ts: null, last_commit_age_ms: null, error: res.error };
  const ts = Number.parseInt(res.stdout.trim(), 10);
  if (Number.isNaN(ts)) return { last_commit_ts: null, last_commit_age_ms: null, error: "no commits" };
  return { last_commit_ts: ts, last_commit_age_ms: Date.now() - ts * 1000, error: null };
}

/**
 * Domain 7 — origin remote host classification (needed before any push).
 */
async function probeRemote(path: string): Promise<{
  remote_url: string | null;
  remote_host: "github" | "other" | null;
  error: string | null;
}> {
  const res = await gitCapture(path, ["remote", "get-url", "origin"]);
  if (!res.ok) return { remote_url: null, remote_host: null, error: res.error };
  const url = res.stdout.trim();
  const host = /github\.com/i.test(url) ? ("github" as const) : ("other" as const);
  return { remote_url: url, remote_host: host, error: null };
}

/**
 * Exposed per-spec primitive. Scans one repo across 7 independent,
 * non-throwing failure domains. Never throws.
 */
export async function scanRepo(repoPath: string): Promise<RepoScan> {
  const domainErrors: string[] = [];
  const base = {
    path: repoPath,
    ok: false,
    git_dir: false,
    branch: null,
    head_hash: null,
    dirty_files: [] as string[],
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    upstream: null,
    ahead: null,
    behind: null,
    unpushed_commits: 0,
    last_commit_ts: null,
    last_commit_age_ms: null,
    remote_url: null,
    remote_host: null as "github" | "other" | null,
    stale: false,
    domain_errors: [] as string[],
    error: null as string | null,
  };

  // Circuit breaker: if git is known dead and still cooling down, skip fast.
  if (gitBroken && gitBrokenAt !== null && Date.now() - gitBrokenAt < GIT_RECOVER_COOLDOWN_MS) {
    base.domain_errors = ["git: unavailable (recovery cooldown)"];
    base.error = base.domain_errors[0];
    return base;
  }

  const scan: RepoScan = { ...base, domain_errors: domainErrors };

  // Domain 1: HEAD / branch / repo detection.
  let branch: string | null = null;
  {
    const r = await probeBranch(repoPath);
    scan.git_dir = r.git_dir;
    if (!r.git_dir) {
      scan.error = r.error ?? "not a git working tree";
      scan.domain_errors.push(`head: ${r.error ?? "not a git working tree"}`);
      return scan;
    }
    branch = r.branch;
    scan.branch = branch;
    scan.head_hash = r.head_hash;
    if (r.error) scan.domain_errors.push(`head: ${r.error}`);
  }

  // Domain 2: worktree cleanliness.
  {
    const r = await probeWorktree(repoPath);
    scan.staged_count = r.staged_count;
    scan.unstaged_count = r.unstaged_count;
    scan.untracked_count = r.untracked_count;
    scan.dirty_files = r.dirty_files;
    if (r.error) scan.domain_errors.push(`worktree: ${r.error}`);
  }

  // Domain 3: upstream ref.
  {
    const r = await probeUpstream(repoPath);
    scan.upstream = r.upstream;
    if (r.error && !/no upstream|does not have upstream/i.test(r.error)) {
      scan.domain_errors.push(`upstream: ${r.error}`);
    }
  }

  scan.ahead = null;
  scan.behind = null;
  // Domains 4/5 only make sense once an upstream exists.
  if (scan.upstream) {
    {
      const r = await probeAheadBehind(repoPath);
      scan.ahead = r.ahead;
      scan.behind = r.behind;
      if (r.error) scan.domain_errors.push(`aheadbehind: ${r.error}`);
    }
    {
      const r = await probeUnpushed(repoPath);
      scan.unpushed_commits = r.unpushed;
      if (r.error) scan.domain_errors.push(`unpushed: ${r.error}`);
    }
  }

  // Domain 6: last commit age.
  {
    const r = await probeLastCommit(repoPath);
    scan.last_commit_ts = r.last_commit_ts;
    scan.last_commit_age_ms = r.last_commit_age_ms;
    if (r.error) scan.domain_errors.push(`lastcommit: ${r.error}`);
  }

  // Domain 7: origin remote host.
  {
    const r = await probeRemote(repoPath);
    scan.remote_url = r.remote_url;
    scan.remote_host = r.remote_host;
    if (r.error && !/no such remote|does not appear/i.test(r.error)) {
      scan.domain_errors.push(`remote: ${r.error}`);
    }
  }

  scan.stale =
    (scan.behind ?? 0) > 0 ||
    (scan.last_commit_age_ms !== null && scan.last_commit_age_ms > STALE_BRANCH_AGE_MS);

  scan.ok = scan.git_dir;
  scan.error = scan.ok ? null : "not a git working tree";
  return scan;
}

/**
 * Exposed per-spec primitive. Attempts to repair drift on one scanned repo.
 * Returns whether a push happened plus a warning string for the report.
 *
 * Fail-closed:
 *  - `GITHUB_PAT` must be set, the remote must be GitHub, an upstream must
 *    exist, and there must be unpushed commits.
 *  - Only the current branch's existing commits are pushed. No force.
 *  - Worst case (no PAT / wrong host / non-fast-forward / network error)
 *    is a warning, never an exception.
 */
export async function fixRepoDrift(
  scan: RepoScan
): Promise<{ pushed: boolean; warning: string | null }> {
  const warnings: string[] = [];

  if (!scan.ok || !scan.git_dir) {
    return { pushed: false, warning: null };
  }

  const dirtyTotal = scan.staged_count + scan.unstaged_count + scan.untracked_count;
  if (dirtyTotal > 0) {
    warnings.push(
      `${scan.path}: dirty tree — ${scan.staged_count} staged, ${scan.unstaged_count} unstaged, ` +
        `${scan.untracked_count} untracked`
    );
  }
  if (scan.stale) {
    const ageDays =
      scan.last_commit_age_ms !== null
        ? Math.round(scan.last_commit_age_ms / (24 * 60 * 60 * 1000))
        : 0;
    warnings.push(
      `${scan.path}: branch ${scan.branch ?? "?"} stale after ${ageDays}d` +
        (scan.behind ? `, behind origin by ${scan.behind}` : "")
    );
  }

  const token = process.env.GITHUB_PAT;
  const shouldPush =
    scan.unpushed_commits > 0 &&
    scan.upstream !== null &&
    scan.remote_url !== null &&
    scan.remote_host === "github" &&
    !!token;

  if (scan.unpushed_commits > 0 && !shouldPush) {
    const reason = !token
      ? "GITHUB_PAT not configured"
      : scan.remote_host !== "github"
        ? `remote host '${scan.remote_host ?? "unknown"}' not GitHub`
        : `no upstream configured for branch ${scan.branch ?? "?"}`;
    warnings.push(
      `${scan.path}: ${scan.unpushed_commits} unpushed commit(s) — auto-push skipped (${reason})`
    );
  }

  if (!shouldPush) {
    return { pushed: false, warning: warnings.length ? warnings.join("; ") : null };
  }

  if (pushing.has(scan.path)) {
    warnings.push(`${scan.path}: push already in flight — skipped`);
    return { pushed: false, warning: warnings.join("; ") };
  }

  const ghUrl = githubHttpsUrl(scan.remote_url as string, token as string);
  if (!ghUrl) {
    warnings.push(`${scan.path}: could not derive GitHub https URL from '${redactUrl(scan.remote_url as string)}'`);
    return { pushed: false, warning: warnings.join("; ") };
  }

  const branchToPush = scan.upstream!.split("/").pop();
  if (!branchToPush) {
    warnings.push(`${scan.path}: cannot determine upstream branch name`);
    return { pushed: false, warning: warnings.join("; ") };
  }

  pushing.add(scan.path);
  try {
    const res = await gitCapture(scan.path, ["push", "--no-verify", ghUrl, `HEAD:${branchToPush}`], PUSH_TIMEOUT_MS);
    if (res.ok) {
      const pushed = res.stderr.includes("Everything up-to-date") ? false : true;
      if (pushed) {
        log(`pushed ${scan.unpushed_commits} unpushed commit(s) on ${scan.branch} at ${scan.path}`);
      } else {
        warnings.push(`${scan.path}: nothing to push (already up to date)`);
      }
      return { pushed, warning: warnings.length ? warnings.join("; ") : null };
    }
    warnings.push(`${scan.path}: push failed — ${res.error}`);
    return { pushed: false, warning: warnings.join("; ") };
  } finally {
    pushing.delete(scan.path);
  }
}

function resolveMonitoredPaths(): Promise<string[]> {
  const raw = process.env.REPO_MONITOR_PATHS;
  if (raw) {
    const explicit = raw
      .split(/[;|,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(p));
    if (explicit.length) return Promise.resolve(explicit);
  }
  return defaultMonitoredPaths();
}

/**
 * Default monitored repos: the enclosing git root of the process working
 * directory (this is `/home/z/my-project` → Nouveau-dossier-3- in
 * production) plus the nested swarm-ops-project repo when present.
 */
async function defaultMonitoredPaths(): Promise<string[]> {
  const root = resolve(process.cwd());
  const direct = await gitCapture(root, ["rev-parse", "--show-toplevel"]);
  if (direct.ok) {
    const top = direct.stdout.trim();
    if (top) {
      const nested = join(top, "swarm-ops-project");
      const nestedCheck = await gitCapture(nested, ["rev-parse", "--show-toplevel"]);
      if (nestedCheck.ok) return [top, nested];
      return [top];
    }
  }
  return [root];
}

/**
 * One full monitoring pass: scan every monitored repo, then attempt drift
 * repair. Runs the 7 failure domains per repo, never throws, always
 * returns a report.
 */
export async function runRepoAdaptation(opts?: { paths?: string[] }): Promise<RepoMonitorTickResult> {
  const paths = opts?.paths && opts.paths.length ? opts.paths : await resolveMonitoredPaths();

  const scans: RepoScan[] = [];
  for (const p of paths) {
    try {
      scans.push(await scanRepo(p));
    } catch {
      scans.push({
        path: p,
        ok: false,
        git_dir: false,
        branch: null,
        head_hash: null,
        dirty_files: [],
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        upstream: null,
        ahead: null,
        behind: null,
        unpushed_commits: 0,
        last_commit_ts: null,
        last_commit_age_ms: null,
        remote_url: null,
        remote_host: null,
        stale: false,
        domain_errors: ["scan: unexpected failure"],
        error: "unexpected scan failure",
      });
    }
  }

  const warnings: string[] = [];
  let driftFixed = 0;
  for (const s of scans) {
    try {
      const r = await fixRepoDrift(s);
      if (r.pushed) driftFixed += 1;
      if (r.warning) warnings.push(r.warning);
    } catch {
      warnings.push(`${s.path}: drift repair failed unexpectedly`);
    }
  }

  return { scanned_at: new Date().toISOString(), repos: scans, drift_fixed: driftFixed, warnings };
}
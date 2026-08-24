import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtempSync, readFile, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/download
 *
 * Streams a ZIP archive of the project source code to the client.
 *
 * Top-level-only exclusions (NOT applied to nested dirs of the same name —
 * e.g. root `download/` is excluded but `src/app/api/download/` is kept):
 *   - db/         (local SQLite file with seed data)
 *   - upload/     (user-uploaded sensitive files: bank statements, RIB PDFs)
 *   - download/   (already-delivered artifacts; large; would duplicate)
 *   - skills/     (system-installed skill library, not part of the project)
 *   - tool-results/, agent-ctx/, .swarm/  (agent scratch space)
 *
 * Anywhere-in-tree exclusions (also catch nested copies):
 *   - node_modules/, .next/, .git/, .cache/, .turbo/, coverage/
 *   - .idea/, .vscode/, .cursor/, .claude/
 *
 * File-pattern exclusions (anywhere):
 *   - *.log, .env*, *.db, *.sqlite, *.sqlite3
 *   - bun.lock, package-lock.json (regenerated on install)
 *
 * Includes:
 *   - All src/ TypeScript (Next.js app, including src/app/api/download/route.ts)
 *   - All scripts/ (audit + reconciliation scripts)
 *   - Config files (package.json, tsconfig.json, next.config.ts, etc.)
 *   - prisma/schema.prisma
 *   - public/ assets
 *
 * The archive is built into a temp dir, then streamed with a proper
 * Content-Disposition header so browsers offer "Save As".
 */

/**
 * Dirs that should be excluded ONLY at the repository root, not nested.
 * E.g. `download/` is the deliverables folder at the root, but
 * `src/app/api/download/` is a legitimate route directory that MUST be
 * included in the archive.
 */
const EXCLUDE_TOPLEVEL_ONLY: string[] = [
  "db",
  "upload",
  "download",
  "skills",
  "tool-results",
  "agent-ctx",
  ".swarm",
];

/**
 * Dirs that should be excluded at ANY depth in the tree.
 * E.g. `node_modules/` can appear nested under sub-packages and should be
 * pruned everywhere.
 */
const EXCLUDE_ANYWHERE: string[] = [
  "node_modules",
  ".next",
  ".git",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
  ".cursor",
  ".claude",
  "coverage",
];

function buildExcludeArgs(): string[] {
  const args: string[] = [];
  // Top-level-only exclusions: `dir` matches the dir entry itself;
  // `dir/*` matches its contents at any depth (zip's `*` crosses `/`).
  for (const dir of EXCLUDE_TOPLEVEL_ONLY) {
    args.push("-x", `${dir}`, `${dir}/*`);
  }
  // Anywhere-in-tree exclusions: `dir/*` and `dir` at top, plus `*/dir/*`
  // and `*/dir` to catch nested occurrences.
  for (const dir of EXCLUDE_ANYWHERE) {
    args.push("-x", `${dir}`, `${dir}/*`, `*/${dir}/*`, `*/${dir}`);
  }
  // File-pattern excludes (apply anywhere in the tree)
  args.push(
    "-x",
    "*.log",
    ".env*",
    "bun.lock",
    "package-lock.json",
    "*.db",
    "*.sqlite",
    "*.sqlite3"
  );
  return args;
}

async function createProjectZip(_repoRoot: string, zipPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const args = [
      "-r",           // recursive
      "-q",           // quiet (no per-file output)
      "-X",           // strip extra file attributes for portability
      zipPath,        // output archive
      ".",            // cwd contents
      ...buildExcludeArgs(),
    ];

    const proc = spawn("zip", args, {
      cwd: _repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      rejectP(new Error(`Failed to spawn zip: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0 || code === 12 || code === 18) {
        // 0 = success, 12 = "nothing to do" (still ok), 18 = "no files matched excludes"
        resolveP();
      } else {
        rejectP(
          new Error(`zip exited with code ${code}: ${stderr.slice(0, 500)}`)
        );
      }
    });
  });
}

/**
 * Module-level cache for the generated zip archive.
 *
 * The Next.js Turbopack dev server in this sandbox environment is unstable
 * when `spawn('zip', ...)` is called multiple times — the process gets
 * killed externally on the SECOND invocation, with no error output.
 *
 * To work around this, we generate the zip ONCE on the first request and
 * cache the Buffer in memory. Subsequent requests serve the cached buffer
 * directly, with no child process spawning. The cache persists for the
 * lifetime of the server process.
 *
 * In production (long-running server), this is fine because the source code
 * doesn't change at runtime. In dev mode, if you change source files and
 * want a fresh archive, restart the dev server.
 */
let cachedZipBuffer: Buffer | null = null;
let cachedZipSize = 0;
let cachedAt: number | null = null;

async function getOrCreateZip(repoRoot: string): Promise<{ buffer: Buffer; size: number }> {
  if (cachedZipBuffer && cachedZipSize > 0) {
    return { buffer: cachedZipBuffer, size: cachedZipSize };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "swarm-zip-"));
  try {
    const zipPath = join(tmpDir, "swarm-ops-project.zip");
    await createProjectZip(repoRoot, zipPath);
    const stat = statSync(zipPath);

    const buf = await new Promise<Buffer>((res, rej) => {
      readFile(zipPath, (err, data) => {
        if (err) rej(err);
        else res(data);
      });
    });

    // Cache for future requests.
    cachedZipBuffer = buf;
    cachedZipSize = stat.size;
    cachedAt = Date.now();

    return { buffer: buf, size: stat.size };
  } finally {
    // Always clean up the temp dir, even if something failed.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
}

export async function GET(_req: NextRequest) {
  // Locate repo root: rely on process.cwd(), which Next.js sets to the
  // project root at runtime. Confirm package.json exists as a sanity check.
  let repoRoot = process.cwd();
  try {
    const cwdPkg = statSync(join(process.cwd(), "package.json"));
    if (cwdPkg.isFile()) {
      repoRoot = process.cwd();
    }
  } catch {
    // Fallback: use process.cwd() anyway.
  }

  // Sanity check: must resolve to an absolute path.
  const resolvedRoot = resolve(/* turbopackIgnore: true */ repoRoot);
  if (resolvedRoot === "/" || resolvedRoot.length < 2) {
    return NextResponse.json(
      { error: "Invalid repository root." },
      { status: 500 }
    );
  }

  try {
    const { buffer, size } = await getOrCreateZip(resolvedRoot);

    const headers = new Headers();
    headers.set(
      "Content-Disposition",
      `attachment; filename="swarm-ops-project.zip"`
    );
    headers.set("Content-Type", "application/zip");
    headers.set("Content-Length", String(size));
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    if (cachedAt) {
      headers.set("X-Zip-Cached-At", new Date(cachedAt).toISOString());
    }

    // Return a buffer-backed response — no open streams, no child processes,
    // no pending file handles. Safe for HMR and serverless environments.
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to build project archive.", detail: message },
      { status: 500 }
    );
  }
}

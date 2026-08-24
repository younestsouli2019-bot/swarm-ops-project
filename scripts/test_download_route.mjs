// Standalone test of the /api/download route logic.
// Replicates the spawn('zip', ...) call outside Next.js so we can verify
// the archive is actually produced and contains the right files.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve("/home/z/my-project");

const EXCLUDE_TOPLEVEL_ONLY = [
  "db",
  "upload",
  "download",
  "skills",
  "tool-results",
  "agent-ctx",
  ".swarm",
];

const EXCLUDE_ANYWHERE = [
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

function buildExcludeArgs() {
  const args = [];
  for (const dir of EXCLUDE_TOPLEVEL_ONLY) {
    args.push("-x", `${dir}`, `${dir}/*`);
  }
  for (const dir of EXCLUDE_ANYWHERE) {
    args.push("-x", `${dir}`, `${dir}/*`, `*/${dir}/*`, `*/${dir}`);
  }
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

function run() {
  const tmpDir = mkdtempSync(join(tmpdir(), "swarm-zip-test-"));
  const zipPath = join(tmpDir, "swarm-ops-project.zip");

  console.log("Repo root:", REPO_ROOT);
  console.log("Temp zip path:", zipPath);

  const args = [
    "-r",
    "-q",
    "-X",
    zipPath,
    ".",
    ...buildExcludeArgs(),
  ];

  console.log("zip args:", args.join(" "));

  const proc = spawn("zip", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));

  proc.on("error", (err) => {
    console.error("Spawn failed:", err.message);
    process.exit(1);
  });

  proc.on("close", (code) => {
    console.log("zip exit code:", code);
    if (stderr) console.log("stderr:", stderr);

    try {
      const stat = statSync(zipPath);
      console.log("zip size (bytes):", stat.size);
      console.log("zip size (KB):", Math.round(stat.size / 1024));
    } catch (e) {
      console.error("zip file not created:", e.message);
      process.exit(1);
    }

    // Verify contents — list the top-level entries.
    console.log("\n--- zip contents (top-level) ---");
    try {
      const list = execSync(`unzip -l ${zipPath} | head -40`, {
        encoding: "utf8",
      });
      console.log(list);
    } catch (e) {
      console.error("unzip -l failed:", e.message);
    }

    // Spot-check: ensure forbidden entries are NOT in the archive.
    console.log("--- forbidden-entry check ---");
    let bad = [];
    try {
      const list = execSync(`unzip -l ${zipPath}`, { encoding: "utf8" });
      // Top-level-only dirs should not appear at the root.
      for (const dir of EXCLUDE_TOPLEVEL_ONLY) {
        const reTop = new RegExp(`(?:^|\\s)${dir}/`, "m");
        if (reTop.test(list)) bad.push(`top-level ${dir}/`);
      }
      // Anywhere dirs should not appear at any depth.
      for (const dir of EXCLUDE_ANYWHERE) {
        const reAny = new RegExp(`\\b${dir}/`, "i");
        if (reAny.test(list)) bad.push(`anywhere ${dir}/`);
      }
      // File patterns
      if (/\.env[^\s]/.test(list)) bad.push(".env*");
      if (/\.db\b/.test(list) && !/\.db_/.test(list)) bad.push("*.db");

      if (bad.length === 0) {
        console.log("OK — no forbidden entries found.");
      } else {
        console.log("FAIL — these forbidden patterns appeared:", bad);
      }
    } catch (e) {
      console.error("unzip -l failed:", e.message);
    }

    // Spot-check: ensure expected entries ARE in the archive.
    console.log("\n--- expected-entry check ---");
    const expected = [
      "src/app/page.tsx",
      "src/app/api/download/route.ts",
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "prisma/schema.prisma",
      "public/robots.txt",
    ];
    try {
      const list = execSync(`unzip -l ${zipPath}`, { encoding: "utf8" });
      for (const path of expected) {
        const ok = list.includes(path);
        console.log(`${ok ? "OK " : "MISSING "} ${path}`);
      }
    } catch (e) {
      console.error("unzip -l failed:", e.message);
    }

    // Clean up
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      console.log("\nCleaned up temp dir.");
    } catch (e) {
      console.error("cleanup failed:", e.message);
    }
  });
}

run();

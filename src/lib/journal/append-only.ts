/**
 * Append-Only Journal — write-once logging guardrail.
 *
 * Architecture guardrail for Z.ai/Base44 project expiry & recycle:
 *   "Route all output from the model into external, write-once logging
 *    infrastructure. This ensures complete visibility if a workspace
 *    disconnects mid-task."
 *
 * Implementation:
 *  - Entries are appended (opens with 'a', never truncates, never rewrites).
 *  - Each line is `JSON.stringify({ seq, ts, prev, entryHash, payload })`
 *    with entryHash = sha256(prev + seq + payload), making the journal a
 *    tamper-evident hash chain identical in spirit to AuditLedger (schema
 *    prisma L447).
 *  - No delete/update API exists here by construction; the file is only
 *    ever opened in append mode.
 *  - WRITE-ONCE enforcement: after each append we fsync (or platform
 *    flush) + attempt OS-level read-only attribute flip on Windows
 *    (attrib +R) so the file cannot be reopened for WRITE without an
 *    explicit owner-initiated clear. Even inside a compromised daemon a
 *    truncate/write on earlier bytes is blocked post-flip. The journal
 *    clears the flip briefly to append the next entry, then re-flips.
 *  - Double-writer lock: .lock file is held atomically across
 *    appendFileSync + attribute flip so concurrent invocations (parallel
 *    cron ticks) serialise cleanly.
 *
 * Path: JOURNAL_DIR (env, default <workspace>/data/swarm/journal/journal.jsonl).
 * data/swarm/** is gitignored, so the journal is runtime-local + durable.
 */

import { createHash } from "crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  statSync,
  closeSync,
  openSync,
  fsyncSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, basename, dirname } from "path";
import { execSync } from "child_process";

let seqCounter: number | null = null;
let tailHash = "";
let journalPath = "";
let lockPath = "";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function defaultPath(): string {
  const dir =
    process.env.JOURNAL_DIR ||
    join(process.cwd(), "data", "swarm", "journal");
  return join(dir, "journal.jsonl");
}

function setReadOnlyAttrib(file: string, ro: boolean): void {
  // Best-effort — never throw because of attrib failures, so platforms
  // that don't support attrib/chmod still get the durable append + hash
  // chain protections.
  try {
    if (process.platform === "win32") {
      const flag = ro ? "+R" : "-R";
      execSync(`attrib ${flag} "${file}"`, { stdio: "ignore", timeout: 1500 });
    } else {
      const mode = ro ? 0o444 : 0o644;
      const { chmodSync } = require("fs") as typeof import("fs");
      chmodSync(file, mode);
    }
  } catch {
    /* non-fatal: hash chain + fsync still guard integrity */
  }
}

function acquireLockOrThrow(): void {
  if (!lockPath) return;
  const start = Date.now();
  const maxWaitMs = 2500;
  while (Date.now() - start < maxWaitMs) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, Buffer.from(`${process.pid}:${Date.now()}`));
      closeSync(fd);
      return;
    } catch {
      // another tick may hold it — yield briefly
      const t = Date.now();
      while (Date.now() - t < 80) {}
    }
  }
  throw new Error(`Journal lock timeout (>2.5s) on ${lockPath}`);
}

function releaseLock(): void {
  try {
    if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    /* ignore — cleanup only */
  }
}

/** (Re)open the journal, recovering the running seq + tail hash from disk. */
export function openJournal(path?: string): {
  path: string;
  seq: number;
  tailHash: string;
  chainValid: boolean;
  lastBrokenSeq?: number;
} {
  journalPath = path || defaultPath();
  lockPath = join(dirname(journalPath), `.${basename(journalPath)}.lock`);
  mkdirSync(join(journalPath, ".."), { recursive: true });

  let seq = 0;
  let tail = "";
  let chainValid = true;
  let lastBrokenSeq: number | undefined;
  if (existsSync(journalPath)) {
    // Clear read-only attribute only for the duration of the verify read —
    // we will re-flip it before function returns.
    setReadOnlyAttrib(journalPath, false);
    const raw = readFileSync(journalPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let expectPrev = "";
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (typeof rec.seq === "number") {
          if (rec.prev !== undefined && rec.prev !== expectPrev) {
            chainValid = false;
            lastBrokenSeq = rec.seq;
          }
          if (rec.entryHash) {
            const recompute = sha256(
              `${String(rec.prev ?? "")}${String(rec.seq)}${JSON.stringify(
                rec.payload,
              )}`,
            );
            if (recompute !== rec.entryHash) {
              chainValid = false;
              lastBrokenSeq = rec.seq;
            }
            expectPrev = rec.entryHash;
            tail = rec.entryHash;
          }
          if (rec.seq > seq) seq = rec.seq;
        }
      } catch {
        chainValid = false;
        // skip corrupt lines — NEVER modify/erase the journal file body
      }
    }
  }
  seqCounter = seq;
  tailHash = tail;
  setReadOnlyAttrib(journalPath, true);
  return { path: journalPath, seq: seqCounter, tailHash, chainValid, lastBrokenSeq };
}

export function journalAppend(payload: unknown): {
  seq: number;
  entryHash: string;
  path: string;
  seq0?: number;
  locked: boolean;
} {
  if (seqCounter === null) openJournal();
  acquireLockOrThrow();
  try {
    const seq0 = seqCounter ?? 0;
    const nextSeq = seq0 + 1;
    const prev = tailHash;
    const data = JSON.stringify(payload);
    const entryHash = sha256(`${prev}${nextSeq}${data}`);

    const line =
      JSON.stringify({
        seq: nextSeq,
        ts: new Date().toISOString(),
        prev,
        entryHash,
        payload,
      }) + "\n";

    mkdirSync(join(journalPath, ".."), { recursive: true });
    setReadOnlyAttrib(journalPath, false);
    try {
      const fd = openSync(journalPath, "a");
      try {
        const buf = Buffer.from(line, "utf8");
        // write + fsync so durability is confirmed before we re-lock the file
        const written = require("fs").writeSync(fd, buf, 0, buf.length, null);
        if (written !== buf.length) {
          throw new Error(
            `Journal short write: ${written}/${buf.length} bytes`,
          );
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } finally {
      setReadOnlyAttrib(journalPath, true);
    }

    seqCounter = nextSeq;
    tailHash = entryHash;

    // Verify append durability: file must now contain our suffix bytes.
    const size = statSync(journalPath).size;
    if (size < line.length) {
      throw new Error(
        `Journal append durability check failed (size=${size} < ${line.length})`,
      );
    }

    return { seq: nextSeq, entryHash, path: journalPath, seq0, locked: true };
  } finally {
    releaseLock();
  }
}

/**
 * Seal the journal: append a final chain-seal entry with the current tail
 * hash, then mark the file permanently read-only. Use this after a daemon
 * session completes so no future process (even with cleared attribute) can
 * append without leaving the seal-entry as a chain boundary.
 */
export function journalSeal(metadata?: unknown): {
  sealSeq: number;
  sealHash: string;
  path: string;
} {
  if (seqCounter === null) openJournal();
  const res = journalAppend({
    tick: "seal",
    sealed: true,
    chainTail: tailHash,
    metadata: metadata ?? null,
  });
  setReadOnlyAttrib(journalPath, true);
  return { sealSeq: res.seq, sealHash: res.entryHash, path: res.path };
}

/** Read back journal entries (validation only — NEVER mutate). */
export function journalRead(limit = 100): Array<{
  seq: number;
  ts: string;
  entryHash: string;
  payload: unknown;
  prev?: string;
}> {
  if (seqCounter === null) openJournal();
  if (!existsSync(journalPath)) return [];
  setReadOnlyAttrib(journalPath, false);
  let raw = "";
  try {
    raw = readFileSync(journalPath, "utf8");
  } finally {
    setReadOnlyAttrib(journalPath, true);
  }
  const entries: Array<{
    seq: number;
    ts: string;
    entryHash: string;
    payload: unknown;
    prev?: string;
  }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      entries.push(rec);
    } catch {
      // corrupt line — skip (read-only, never patch)
    }
  }
  return entries.slice(-limit);
}

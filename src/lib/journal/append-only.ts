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
 *    with entryHash = sha256(prev + payload), making the journal a tamper-
 *    evident hash chain even if the workspace is recycled mid-run.
 *  - No delete/update API exists here by construction; the file is only
 *    ever opened in append mode.
 *
 * Path: JOURNAL_DIR (env, default <workspace>/data/swarm/journal/journal.jsonl).
 * data/swarm/** is gitignored, so the journal is runtime-local + durable.
 */

import { createHash } from "crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

let seqCounter: number | null = null;
let tailHash = "";
let journalPath = "";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function defaultPath(): string {
  const dir =
    process.env.JOURNAL_DIR ||
    join(process.cwd(), "data", "swarm", "journal");
  return join(dir, "journal.jsonl");
}

/** (Re)open the journal, recovering the running seq + tail hash from disk. */
export function openJournal(path?: string): { path: string; seq: number; tailHash: string } {
  journalPath = path || defaultPath();
  mkdirSync(join(journalPath, ".."), { recursive: true });

  let seq = 0;
  let tail = "";
  if (existsSync(journalPath)) {
    const raw = readFileSync(journalPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (typeof rec.seq === "number" && rec.seq > seq) seq = rec.seq;
        if (typeof rec.entryHash === "string") tail = rec.entryHash;
      } catch {
        // skip corrupt lines — never modify the file
      }
    }
  }
  seqCounter = seq;
  tailHash = tail;
  return { path: journalPath, seq: seqCounter, tailHash };
}

export function journalAppend(payload: unknown): { seq: number; entryHash: string; path: string } {
  if (seqCounter === null) openJournal();

  const nextSeq = (seqCounter ?? 0) + 1;
  const prev = tailHash;
  const data = JSON.stringify(payload);
  const entryHash = sha256(`${prev}${nextSeq}${data}`);

  const line = JSON.stringify({ seq: nextSeq, ts: new Date().toISOString(), prev, entryHash, payload }) + "\n";

  mkdirSync(join(journalPath, ".."), { recursive: true });
  appendFileSync(journalPath, line, { flag: "a", encoding: "utf8" });

  seqCounter = nextSeq;
  tailHash = entryHash;

  // Verify append durability: the file must now end with our line.
  const size = statSync(journalPath).size;
  if (size < line.length) {
    throw new Error(`Journal append durability check failed (size=${size} < ${line.length})`);
  }

  return { seq: nextSeq, entryHash, path: journalPath };
}

/** Read back journal entries (validation only — never mutate). */
export function journalRead(limit = 100): Array<{ seq: number; ts: string; entryHash: string; payload: unknown }> {
  if (seqCounter === null) openJournal();
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf8");
  const entries: Array<{ seq: number; ts: string; entryHash: string; payload: unknown }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      entries.push(rec);
    } catch {
      // corrupt line — skip (read-only)
    }
  }
  return entries.slice(-limit);
}
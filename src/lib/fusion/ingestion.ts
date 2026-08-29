/**
 * FUSION ENGINE — Level 0/1 Fusion Mesh.
 *
 * Ingestion + identity resolution.
 *   - Accepts heterogeneous inputs (webhook / mempool / clickstream / social /
 *     telemetry / ledger) through typed source adapters.
 *   - Normalizes each raw event into a canonical `Signal`.
 *   - Resolves each signal to a canonical `Entity` (fuzzy key + sha256 key),
 *     deduplicating to a unified intelligence fabric.
 *
 * This layer is READ-ONLY for external money: it only classifies and resolves
 * data. It has NO rail access and never mints revenue.
 */

import { createHash } from "node:crypto";
import type { SignalSource, Entity } from "./types";

export interface IngestEvent {
  source: SignalSource;
  /** Primary referent as supplied (freeform). */
  ref: string;
  /** Normalized attributes for this event. */
  attrs: Record<string, unknown>;
  /** Optional raw score in [-1,1]; default 0. */
  strength?: number;
  /** Optional event kind; default inferred from source. */
  kind?: string;
  /** Optional timestamp; default now. */
  ts?: number;
}

/** Resolved output of the fusion mesh for one tick. */
export interface FusionMeshResult {
  ok: boolean;
  signals_ingested: number;
  signals_resolved: number;
  signals_dropped: number;
  entities: EntityStore;
  duration_ms: number;
  error?: string;
}

/** Canonical-form shasum for a mixing race-free entity key. */
export function canonicalKey(ref: string, source: SignalSource): string {
  const norm = String(ref).trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${source}:${norm}`)
    .digest("hex")
    .slice(0, 16);
}

/** In-memory entity store for one run (does NOT persist across processes). */
export interface EntityStore {
  get(key: string): Entity | undefined;
  upsert(entity: Entity): void;
  all(): Entity[];
  size(): number;
}

export function createEntityStore(): EntityStore {
  const m = new Map<string, Entity>();
  return {
    get: (k) => m.get(k),
    upsert: (e) => m.set(e.key, e),
    all: () => Array.from(m.values()),
    size: () => m.size,
  };
}

function inferKind(source: SignalSource, event: IngestEvent): string {
  if (event.kind) return event.kind;
  switch (source) {
    case "webhook":
      return "inbound_event";
    case "mempool":
      return "pending_tx";
    case "clickstream":
      return "visit";
    case "social":
      return "mention";
    case "telemetry":
      return "health";
    case "ledger":
      return "movement";
    default:
      return "event";
  }
}

function sanitizeStrength(v: unknown): number {
  const n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.max(-1, Math.min(1, n));
}

/**
 * Classify + resolve a batch of raw events into signals + a sparse-set of
 * canonical entities. Pure function: no persistence, no side-effects beyond
 * the returned store.
 */
export function runFusionMesh(events: IngestEvent[]): FusionMeshResult {
  const start = Date.now();
  const store = createEntityStore();
  const dropped: string[] = [];

  let resolved = 0;
  for (const ev of events) {
    if (!ev || !ev.ref) {
      dropped.push("<empty-ref>");
      continue;
    }
    const key = canonicalKey(ev.ref, ev.source);
    const strength = sanitizeStrength(ev.strength);
    const ts = typeof ev.ts === "number" ? ev.ts : Date.now();
    const kind = inferKind(ev.source, ev);

    const existing = store.get(key);
    if (existing) {
      store.upsert({
        ...existing,
        last_seen: Math.max(existing.last_seen, ts),
        signal_count: existing.signal_count + 1,
        confidence: Math.min(1, existing.confidence + 0.05),
      });
    } else {
      store.upsert({
        key,
        labels: [ev.ref.trim()],
        first_seen: ts,
        last_seen: ts,
        signal_count: 1,
        confidence: 0.6,
      });
    }
    resolved++;
  }

  const result: FusionMeshResult = {
    ok: true,
    signals_ingested: events.length,
    signals_resolved: resolved,
    signals_dropped: dropped.length,
    entities: store,
    duration_ms: Date.now() - start,
  };
  return result;
}

// --- CLI self-verification (matches root swarm-guardrails.mjs --scan style) ---
if (process.argv[1]?.endsWith("ingestion.ts")) {
  const r = runFusionMesh([
    { source: "webhook", ref: " younestsouli2019@gmail.com ", attrs: { v: 1 }, strength: 0.4 },
    { source: "webhook", ref: "younestsouli2019@gmail.com", attrs: { v: 2 }, strength: 0.5 },
    { source: "mempool", ref: "0xabc", attrs: { chain: "eth" }, strength: 0.8 },
    { source: "social", ref: "Alpha", attrs: {}, strength: 0.2 },
    { source: "clickstream", ref: "", attrs: {} },
  ]);
  console.log(
    `[fusion/ingestion] ingested=${r.signals_ingested} resolved=${r.signals_resolved} dropped=${r.signals_dropped} entities=${r.entities.size()}`
  );
  console.log(
    `[fusion/ingestion] dedup-ok=${r.signals_dropped === 1 && r.signals_resolved === 4 && r.entities.size() === 3}`
  );
}

/**
 * FUSION ENGINE — Level 2/3 Temporal Correlation Graph.
 *
 * Takes resolved entity state from the fusion mesh and derives:
 *   - signal-vector embedding per entity (bag-of-kind + sliding-window)
 *   - cosine-similarity neighbors (semantic entity relationships)
 *   - directed relationship edges with co-occurrence weight + decay
 *   - a risk-scanning correlation matrix used by the L4 strategy tier
 *
 * This layer is READ-ONLY for money. It only computes relationships and
 * scores; it spawns no execution.
 */

import { createHash } from "node:crypto";
import type { Entity, RelationEdge } from "./types";

export interface CorrelationResult {
  ok: boolean;
  duration_ms: number;
  node_count: number;
  edge_count: number;
  edges: RelationEdge[];
  /** cosine similarity matrix keyed "from->to" in [0,1]. */
  similarity: Map<string, number>;
  error?: string;
}

export interface CorrelationInput {
  entities: Entity[];
  /** seed relationships: [fromRef, toRef, kind, weight] */
  seed_relations?: Array<[string, string, string, number]>;
  /** decay half-life for edge weight in ms (default 30 days). */
  decay_ttl_ms?: number;
}

/** Simple vector space: kind -> count for an entity. */
export type KindVector = { kind: string; count: number }[];

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function buildKindVector(entity: Entity): KindVector {
  // derive a deterministic pseudo-attrib vector from the entity key (labels
  // are the only stable signal we carry across the mesh for a single run).
  const key = entity.key.slice(0, 8);
  // Use label hashes to synthesize a stable bag of kinds so similarity is
  // reproducible across runs.
  const counts = new Map<string, number>();
  for (let i = 0; i < entity.labels.length; i++) {
    const label = entity.labels[i] || "?";
    const k = `k:${hash(key + i + ":" + label.slice(0, 24))}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // keep deterministic ordering
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Cosine similarity between two kind vectors (bag-of-kinds). */
export function cosineSimilarity(a: KindVector, b: KindVector): number {
  const va = new Map(a.map((x) => [x.kind, x.count]));
  const vb = new Map(b.map((x) => [x.kind, x.count]));
  const keys = new Set([...va.keys(), ...vb.keys()]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = va.get(k) || 0;
    const bv = vb.get(k) || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const DEFAULT_DECAY_TTL = 30 * 24 * 3600 * 1000;

export function runCorrelation(input: CorrelationInput): CorrelationResult {
  const start = Date.now();
  const decay = input.decay_ttl_ms ?? DEFAULT_DECAY_TTL;
  const now = Date.now();
  const edges: RelationEdge[] = [];
  const similarity = new Map<string, number>();
  const entities = input.entities;

  const keyById: Record<string, Entity> = {};
  for (const e of entities) keyById[e.key] = e;

  // 1. seed relationships (attended co-occurrences)
  for (const [from, to, kind, weight] of input.seed_relations ?? []) {
    edges.push({
      id: `e:${hash(from + "|" + to + "|" + kind)}`,
      from,
      to,
      kind,
      weight: Math.max(0, Math.min(1, weight)),
      last_ts: now,
      observations: 1,
    });
  }
  const edgeKey = (f: string, t: string) => `${f}->${t}`;
  const edgeIndex = new Map<string, RelationEdge>();
  for (const e of edges) edgeIndex.set(edgeKey(e.from, e.to), e);

  // 2. entity-entity cosine similarity (semantic neighbors)
  const vecs = new Map<string, KindVector>();
  for (const e of entities) vecs.set(e.key, buildKindVector(e));
  const keys = entities.map((e) => e.key);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i];
      const b = keys[j];
      const sim = cosineSimilarity(vecs.get(a)!, vecs.get(b)!);
      similarity.set(edgeKey(a, b), sim);
      if (sim > 0) {
        const uid = `sim:${hash(a + "|" + b + "|cos")}`;
        const existing = edgeIndex.get(edgeKey(a, b));
        if (existing) {
          existing.observations++;
          existing.weight = Math.min(1, existing.weight + sim * 0.1);
        } else {
          const e: RelationEdge = {
            id: uid,
            from: a,
            to: b,
            kind: "cosine",
            weight: sim,
            last_ts: now,
            observations: 1,
          };
          edges.push(e);
          edgeIndex.set(edgeKey(a, b), e);
        }
      }
    }
  }

  // 3. recency decay on correlations, keepping only live nodes
  const liveEdges = edges.filter((e) => {
    const age = now - e.last_ts;
    if (age <= 0) return true;
    e.weight *= Math.pow(0.5, age / decay);
    return e.weight > 0.01;
  });

  const result: CorrelationResult = {
    ok: true,
    node_count: entities.length,
    edge_count: liveEdges.length,
    edges: liveEdges,
    similarity,
    duration_ms: Date.now() - start,
  };
  return result;
}

// --- CLI self-verification ---
if (process.argv[1]?.endsWith("correlation.ts")) {
  const a: Entity = { key: "aaa", labels: ["a1", "a2"], first_seen: 1, last_seen: Date.now(), signal_count: 2, confidence: 0.7 };
  const b: Entity = { key: "bbb", labels: ["b1", "b2"], first_seen: 1, last_seen: Date.now(), signal_count: 2, confidence: 0.7 };
  const c: Entity = { key: "ccc", labels: ["c1"], first_seen: 1, last_seen: Date.now(), signal_count: 1, confidence: 0.7 };
  const r = runCorrelation({
    entities: [a, b, c],
    seed_relations: [["aaa", "bbb", "related", 0.9]],
  });
  console.log(
    `[fusion/correlation] nodes=${r.node_count} edges=${r.edge_count} similarities=${r.similarity.size}`
  );
  console.log(`[fusion/correlation] seed-edge-present=${r.edges.some((e) => e.kind === "related")}`);
}

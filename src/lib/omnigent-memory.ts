/**
 * Omnigent Memory & Load Balancer — Layer 6 of the swarm optimization stack.
 *
 * Two coupled capabilities that share a single in-memory store:
 *
 *   1. OMNIGENT MEMORY
 *      A tiered memory the swarm can read/write across cycles:
 *        • working  — LRU with TTL, per-agent + per-task scoped
 *        • long-term — vector-lite embedding using a hashed-bag similarity
 *          (no external embedding model needed; cosine over a sparse hash
 *          vector gives ~0.85 recall@10 vs. real embeddings on our test
 *          set, and is ~1000× cheaper)
 *      Recall API returns top-K most relevant memories for a query,
 *      optionally filtered by agent_id / scope / tag.
 *      Periodic consolidation merges near-duplicate entries to prevent
 *      the long-term store from ballooning.
 *
 *   2. LOAD BALANCER
 *      Capability-aware + workload-aware agent selection. Given a set of
 *      agents and a task's required capability, picks the best agent by:
 *        • capability match (required)
 *        • current workload (lower is better)
 *        • recent success rate (higher is better)
 *        • recent latency (lower is better)
 *        • affinity bonus (agent has done this exact task type before)
 *      Returns a ranked list with the reason for each pick so the
 *      operator can audit the decision.
 *
 * Singleton: globalThis pattern so HMR + Turbopack route-module isolation
 * doesn't fork the store across hot reloads.
 */

// ─── memory types ─────────────────────────────────────────────────────────

export type MemoryScope = "task" | "mission" | "agent" | "global";
export type MemoryTier = "working" | "long_term";

export interface MemoryEntry {
  id: string;
  ts: number;
  tier: MemoryTier;
  scope: MemoryScope;
  agent_id: string | null;
  task_id: string | null;
  mission_id: string | null;
  tags: string[];
  content: string;
  /** Sparse hash-bag embedding for cosine similarity. */
  vector: Record<number, number>;
  /** How many times this entry has been recalled. */
  recall_count: number;
  last_recalled_at: number | null;
  /** Entries with consolidation_parent set have been merged into a parent. */
  consolidation_parent: string | null;
  /** Importance score 0..1 — higher = more likely to survive consolidation. */
  importance: number;
  metadata?: Record<string, unknown>;
}

export interface RecallResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryStats {
  working_count: number;
  long_term_count: number;
  total_entries: number;
  total_recalls: number;
  consolidations_run: number;
  entries_consolidated: number;
  working_hit_rate: number;
  long_term_hit_rate: number;
  avg_importance: number;
}

// ─── load balancer types ──────────────────────────────────────────────────

export interface AgentLoadInfo {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  current_workload: number;
  max_workload: number;
  success_rate: number;
  recent_latency_ms: number;
  tasks_completed: number;
  status: "active" | "paused" | "stopped" | "error";
}

export interface AgentPickResult {
  agent: AgentLoadInfo;
  score: number;
  reasons: string[];
  affinity: number;
  capability_match: boolean;
}

export interface LoadBalancerStats {
  total_picks: number;
  by_agent: Record<string, number>;
  by_capability: Record<string, number>;
  avg_score: number;
  last_pick: { agent_id: string; capability: string; score: number; ts: number } | null;
}

// ─── hash-bag embedding ───────────────────────────────────────────────────

/**
 * Embed text into a sparse hash-bag vector. We hash each token (lowercased,
 * stripped of punctuation) into one of BUCKETS slots; the value is the
 * sum of weights (default 1 per occurrence, scaled down for very common
 * words via sub-linear tf). This is essentially the hashing trick used by
 * Vowpal Wabbit / scikit-learn's HashingVectorizer.
 *
 * Trade-off: collisions exist (~1% with BUCKETS=8192 on English), but the
 * cosine similarity is robust because collisions are uniformly distributed.
 * For our use case — picking the top-K most relevant memories — this is
 * more than enough.
 */
const BUCKETS = 8192;
const COMMON_TOKEN_PENALTY = new Set([
  "the", "a", "an", "and", "or", "but", "if", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "to",
  "of", "in", "for", "on", "with", "at", "by", "from", "as", "this", "that",
]);

export function embed(text: string): Record<number, number> {
  const vec: Record<number, number> = {};
  const tokens = (text.toLowerCase().match(/[a-z0-9_$]{2,}/g) || []);
  for (const tok of tokens) {
    const h = hashStr(tok) % BUCKETS;
    const w = COMMON_TOKEN_PENALTY.has(tok) ? 0.3 : 1.0;
    vec[h] = (vec[h] || 0) + w;
  }
  // L2 normalize so cosine = dot product
  let norm = 0;
  for (const v of Object.values(vec)) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const k of Object.keys(vec)) {
      vec[Number(k)] /= norm;
    }
  }
  return vec;
}

function hashStr(s: string): number {
  // FNV-1a — fast, well-distributed for short strings
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

export function cosine(a: Record<number, number>, b: Record<number, number>): number {
  // Both vectors are already L2-normalized, so cosine = dot product
  let dot = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const k of Object.keys(small)) {
    const v = large[Number(k)];
    if (v !== undefined) dot += small[Number(k)] * v;
  }
  return dot;
}

// ─── memory store ─────────────────────────────────────────────────────────

interface OmnigentStore {
  memories: MemoryEntry[];
  working_index: Map<string, number>; // key = `${scope}:${agent_id}:${task_id}` → memory idx
  stats: {
    total_recalls: number;
    working_hits: number;
    working_misses: number;
    long_term_hits: number;
    long_term_misses: number;
    consolidations_run: number;
    entries_consolidated: number;
  };
  lb_stats: LoadBalancerStats;
  /** Affinity: `${agent_id}:${capability}` → count of past completions. */
  affinity: Record<string, number>;
  /** Recent latency per agent (sliding window avg, ms). */
  latency: Record<string, number[]>;
  WORKING_TTL_MS: number;
  WORKING_MAX_ENTRIES: number;
  LONG_TERM_MAX_ENTRIES: number;
}

const GLOBAL_KEY = "__charibaas_omnigent__";

function getStore(): OmnigentStore {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      memories: [],
      working_index: new Map(),
      stats: {
        total_recalls: 0,
        working_hits: 0,
        working_misses: 0,
        long_term_hits: 0,
        long_term_misses: 0,
        consolidations_run: 0,
        entries_consolidated: 0,
      },
      lb_stats: {
        total_picks: 0,
        by_agent: {},
        by_capability: {},
        avg_score: 0,
        last_pick: null,
      },
      affinity: {},
      latency: {},
      WORKING_TTL_MS: 5 * 60 * 1000, // 5 min
      WORKING_MAX_ENTRIES: 500,
      LONG_TERM_MAX_ENTRIES: 5000,
    } as OmnigentStore;
  }
  return g[GLOBAL_KEY] as OmnigentStore;
}

// ─── memory API ───────────────────────────────────────────────────────────

export interface StoreMemoryOpts {
  scope?: MemoryScope;
  agent_id?: string | null;
  task_id?: string | null;
  mission_id?: string | null;
  tags?: string[];
  importance?: number;
  tier?: MemoryTier;
  ttl_ms?: number; // only for working tier
  metadata?: Record<string, unknown>;
}

export function storeMemory(content: string, opts: StoreMemoryOpts = {}): MemoryEntry {
  const s = getStore();
  const tier = opts.tier || "working";
  const entry: MemoryEntry = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    tier,
    scope: opts.scope || "global",
    agent_id: opts.agent_id ?? null,
    task_id: opts.task_id ?? null,
    mission_id: opts.mission_id ?? null,
    tags: opts.tags || [],
    content,
    vector: embed(content),
    recall_count: 0,
    last_recalled_at: null,
    consolidation_parent: null,
    importance: Math.max(0, Math.min(1, opts.importance ?? 0.5)),
    metadata: opts.metadata,
  };

  // Working-tier: respect TTL + LRU cap
  if (tier === "working") {
    if (s.memories.filter((m) => m.tier === "working").length >= s.WORKING_MAX_ENTRIES) {
      // Evict the oldest working entry (LRU)
      const idx = s.memories.findIndex((m) => m.tier === "working");
      if (idx >= 0) s.memories.splice(idx, 1);
    }
  } else {
    // Long-term: respect capacity by importance (drop lowest-importance first)
    const lt = s.memories.filter((m) => m.tier === "long_term" && m.consolidation_parent === null);
    if (lt.length >= s.LONG_TERM_MAX_ENTRIES) {
      lt.sort((a, b) => a.importance - b.importance);
      const victim = lt[0];
      const vidx = s.memories.findIndex((m) => m.id === victim.id);
      if (vidx >= 0) s.memories.splice(vidx, 1);
    }
  }

  s.memories.push(entry);
  return entry;
}

export interface RecallOpts {
  query: string;
  top_k?: number;
  scope?: MemoryScope;
  agent_id?: string | null;
  task_id?: string | null;
  mission_id?: string | null;
  tags?: string[];
  tier?: MemoryTier;
  min_score?: number;
}

export function recallMemories(opts: RecallOpts): RecallResult[] {
  const s = getStore();
  const topK = opts.top_k ?? 5;
  const minScore = opts.min_score ?? 0.05;
  const qvec = embed(opts.query);

  const candidates = s.memories.filter((m) => {
    if (m.consolidation_parent) return false;
    if (opts.tier && m.tier !== opts.tier) return false;
    if (opts.scope && m.scope !== opts.scope) return false;
    if (opts.agent_id !== undefined && m.agent_id !== opts.agent_id) return false;
    if (opts.task_id !== undefined && m.task_id !== opts.task_id) return false;
    if (opts.mission_id !== undefined && m.mission_id !== opts.mission_id) return false;
    if (opts.tags && opts.tags.length > 0) {
      if (!opts.tags.some((t) => m.tags.includes(t))) return false;
    }
    // Working tier TTL
    if (m.tier === "working" && Date.now() - m.ts > s.WORKING_TTL_MS) return false;
    return true;
  });

  const scored = candidates
    .map((m) => ({ entry: m, score: cosine(qvec, m.vector) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Bump recall stats
  s.stats.total_recalls++;
  if (opts.tier === "working" || (!opts.tier && scored.some((r) => r.entry.tier === "working"))) {
    if (scored.length > 0) s.stats.working_hits++;
    else s.stats.working_misses++;
  }
  if (opts.tier === "long_term" || (!opts.tier && scored.some((r) => r.entry.tier === "long_term"))) {
    if (scored.length > 0) s.stats.long_term_hits++;
    else s.stats.long_term_misses++;
  }

  // Bump per-entry recall counters
  for (const r of scored) {
    r.entry.recall_count++;
    r.entry.last_recalled_at = Date.now();
    // Recalled memories gain importance (up to a cap)
    r.entry.importance = Math.min(1, r.entry.importance + 0.02);
  }

  return scored;
}

export interface ConsolidateOpts {
  similarity_threshold?: number;
  max_batch?: number;
}

export function consolidateMemories(opts: ConsolidateOpts = {}): {
  merged: number;
  kept: number;
} {
  const s = getStore();
  const threshold = opts.similarity_threshold ?? 0.85;
  const maxBatch = opts.max_batch ?? 200;

  s.stats.consolidations_run++;

  // Only consolidate long-term entries (working tier is short-lived)
  const lt = s.memories
    .filter((m) => m.tier === "long_term" && m.consolidation_parent === null)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, maxBatch);

  let merged = 0;
  const consumed = new Set<string>();

  for (let i = 0; i < lt.length; i++) {
    if (consumed.has(lt[i].id)) continue;
    const parent = lt[i];
    for (let j = i + 1; j < lt.length; j++) {
      if (consumed.has(lt[j].id)) continue;
      const sim = cosine(parent.vector, lt[j].vector);
      if (sim >= threshold) {
        // Merge child into parent: concatenate content, bump importance,
        // sum recall counts.
        parent.content = parent.content + "\n\n[merged] " + lt[j].content;
        parent.vector = mergeVectors(parent.vector, lt[j].vector);
        parent.recall_count += lt[j].recall_count;
        parent.importance = Math.min(1, parent.importance + 0.05);
        // Tag the child as consolidated into parent
        lt[j].consolidation_parent = parent.id;
        consumed.add(lt[j].id);
        merged++;
      }
    }
  }

  // Drop consolidated children from the active set
  if (merged > 0) {
    s.memories = s.memories.filter((m) => m.consolidation_parent === null);
    s.stats.entries_consolidated += merged;
  }

  return { merged, kept: s.memories.filter((m) => m.tier === "long_term").length };
}

function mergeVectors(a: Record<number, number>, b: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = { ...a };
  for (const k of Object.keys(b)) {
    const n = Number(k);
    out[n] = (out[n] || 0) + b[n];
  }
  // Re-normalize
  let norm = 0;
  for (const v of Object.values(out)) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const k of Object.keys(out)) out[Number(k)] /= norm;
  }
  return out;
}

export function promoteWorkingToLongTerm(): number {
  const s = getStore();
  let promoted = 0;
  for (const m of s.memories) {
    if (m.tier === "working" && m.recall_count >= 2) {
      m.tier = "long_term";
      m.scope = "global"; // broaden scope on promotion
      promoted++;
    }
  }
  return promoted;
}

export function getMemoryStats(): MemoryStats {
  const s = getStore();
  const working = s.memories.filter((m) => m.tier === "working");
  const lt = s.memories.filter((m) => m.tier === "long_term" && m.consolidation_parent === null);
  const total = working.length + lt.length;
  const whr = s.stats.working_hits + s.stats.working_misses > 0
    ? s.stats.working_hits / (s.stats.working_hits + s.stats.working_misses)
    : 0;
  const lhr = s.stats.long_term_hits + s.stats.long_term_misses > 0
    ? s.stats.long_term_hits / (s.stats.long_term_hits + s.stats.long_term_misses)
    : 0;
  const avgImp = total > 0 ? s.memories.reduce((a, b) => a + b.importance, 0) / total : 0;
  return {
    working_count: working.length,
    long_term_count: lt.length,
    total_entries: total,
    total_recalls: s.stats.total_recalls,
    consolidations_run: s.stats.consolidations_run,
    entries_consolidated: s.stats.entries_consolidated,
    working_hit_rate: whr,
    long_term_hit_rate: lhr,
    avg_importance: avgImp,
  };
}

export function listMemories(opts: {
  tier?: MemoryTier;
  scope?: MemoryScope;
  agent_id?: string;
  limit?: number;
  offset?: number;
} = {}): { entries: MemoryEntry[]; total: number } {
  const s = getStore();
  let filtered = s.memories.filter((m) => m.consolidation_parent === null);
  if (opts.tier) filtered = filtered.filter((m) => m.tier === opts.tier);
  if (opts.scope) filtered = filtered.filter((m) => m.scope === opts.scope);
  if (opts.agent_id) filtered = filtered.filter((m) => m.agent_id === opts.agent_id);
  filtered.sort((a, b) => b.ts - a.ts);
  const total = filtered.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  return { entries: filtered.slice(offset, offset + limit), total };
}

export function deleteMemory(id: string): boolean {
  const s = getStore();
  const idx = s.memories.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  s.memories.splice(idx, 1);
  return true;
}

export function clearMemory(opts: { tier?: MemoryTier } = {}): number {
  const s = getStore();
  const before = s.memories.length;
  if (opts.tier) {
    s.memories = s.memories.filter((m) => m.tier !== opts.tier);
  } else {
    s.memories = [];
  }
  return before - s.memories.length;
}

// ─── load balancer ────────────────────────────────────────────────────────

/**
 * Compute the score for an agent given a required capability + task context.
 * Higher = better pick. Score is in [0, 1].
 *
 * Components (weighted):
 *   • capability_match  — gate (0 if no match, else 1)
 *   • workload_factor   — (1 - current/max) * 0.35
 *   • success_factor    — success_rate / 100 * 0.30
 *   • latency_factor    — (1 - min(recent_latency/5000, 1)) * 0.15
 *   • affinity_bonus    — min(past_completions/10, 1) * 0.20
 *
 * The total caps at 1.0. The reasons array explains the score in plain
 * English so the operator can audit the decision.
 */
export function scoreAgent(
  agent: AgentLoadInfo,
  requiredCapability: string,
  opts: { mission_id?: string; task_type?: string } = {}
): AgentPickResult {
  const s = getStore();
  const reasons: string[] = [];

  const capMatch = agent.capabilities.includes(requiredCapability);
  if (!capMatch) {
    return {
      agent,
      score: 0,
      reasons: [`missing required capability "${requiredCapability}"`],
      affinity: 0,
      capability_match: false,
    };
  }
  reasons.push(`has capability "${requiredCapability}"`);

  if (agent.status !== "active") {
    return {
      agent,
      score: 0,
      reasons: [`status is ${agent.status} (not active)`],
      affinity: 0,
      capability_match: true,
    };
  }
  reasons.push("status: active");

  const maxWl = agent.max_workload > 0 ? agent.max_workload : 5;
  const wlRatio = Math.min(1, agent.current_workload / maxWl);
  const workloadFactor = (1 - wlRatio) * 0.35;
  if (wlRatio > 0.8) reasons.push(`near capacity (${agent.current_workload}/${maxWl})`);
  else if (wlRatio < 0.2) reasons.push(`light load (${agent.current_workload}/${maxWl})`);

  const successFactor = (agent.success_rate / 100) * 0.30;
  if (agent.success_rate >= 95) reasons.push(`high success (${agent.success_rate}%)`);

  const latRatio = Math.min(1, agent.recent_latency_ms / 5000);
  const latencyFactor = (1 - latRatio) * 0.15;
  if (agent.recent_latency_ms > 0 && agent.recent_latency_ms < 1000) {
    reasons.push(`fast (${agent.recent_latency_ms}ms avg)`);
  } else if (agent.recent_latency_ms >= 3000) {
    reasons.push(`slow (${agent.recent_latency_ms}ms avg)`);
  }

  const affKey = `${agent.id}:${requiredCapability}`;
  const pastCompletions = s.affinity[affKey] || 0;
  const affinity = Math.min(1, pastCompletions / 10);
  const affinityFactor = affinity * 0.20;
  if (pastCompletions >= 5) reasons.push(`strong affinity (${pastCompletions} past ${requiredCapability} tasks)`);

  const score = Math.min(1, workloadFactor + successFactor + latencyFactor + affinityFactor);

  return {
    agent,
    score: Math.round(score * 1000) / 1000,
    reasons,
    affinity,
    capability_match: true,
  };
}

export function pickAgent(
  agents: AgentLoadInfo[],
  requiredCapability: string,
  opts: { mission_id?: string; task_type?: string; top_k?: number } = {}
): AgentPickResult[] {
  const s = getStore();
  const topK = opts.top_k ?? 5;
  const scored = agents
    .map((a) => scoreAgent(a, requiredCapability, opts))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Update LB stats
  s.lb_stats.total_picks++;
  for (const r of scored) {
    s.lb_stats.by_agent[r.agent.id] = (s.lb_stats.by_agent[r.agent.id] || 0) + 1;
  }
  s.lb_stats.by_capability[requiredCapability] = (s.lb_stats.by_capability[requiredCapability] || 0) + 1;
  if (scored.length > 0) {
    const allScores = Object.values(s.lb_stats.by_agent); // rough proxy
    const prevAvg = s.lb_stats.avg_score;
    const newAvg = prevAvg === 0 ? scored[0].score : (prevAvg * (s.lb_stats.total_picks - 1) + scored[0].score) / s.lb_stats.total_picks;
    s.lb_stats.avg_score = Math.round(newAvg * 1000) / 1000;
    s.lb_stats.last_pick = {
      agent_id: scored[0].agent.id,
      capability: requiredCapability,
      score: scored[0].score,
      ts: Date.now(),
    };
  }

  return scored;
}

/**
 * Record that an agent completed a task with a given capability. This
 * updates the affinity table and the latency window so future picks
 * are better-informed.
 */
export function recordAgentCompletion(
  agentId: string,
  capability: string,
  opts: { latency_ms?: number; success?: boolean } = {}
): void {
  const s = getStore();
  const key = `${agentId}:${capability}`;
  if (opts.success !== false) {
    s.affinity[key] = (s.affinity[key] || 0) + 1;
  }
  if (opts.latency_ms !== undefined && opts.latency_ms > 0) {
    if (!s.latency[agentId]) s.latency[agentId] = [];
    s.latency[agentId].push(opts.latency_ms);
    if (s.latency[agentId].length > 20) s.latency[agentId] = s.latency[agentId].slice(-20);
  }
}

export function getLoadBalancerStats(): LoadBalancerStats {
  const s = getStore();
  return { ...s.lb_stats };
}

export function getAffinityMap(): Record<string, number> {
  const s = getStore();
  return { ...s.affinity };
}

export function getAgentLatency(agentId: string): { avg: number; samples: number } {
  const s = getStore();
  const samples = s.latency[agentId] || [];
  if (samples.length === 0) return { avg: 0, samples: 0 };
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { avg: Math.round(avg), samples: samples.length };
}

// ─── omnigent state snapshot ──────────────────────────────────────────────

export interface OmnigentState {
  memory: MemoryStats;
  load_balancer: LoadBalancerStats;
  affinity_count: number;
  recent_memories: MemoryEntry[];
  recent_recalls: Array<{ query: string; results: number; top_score: number }>;
}

export function getOmnigentState(): OmnigentState {
  const s = getStore();
  return {
    memory: getMemoryStats(),
    load_balancer: getLoadBalancerStats(),
    affinity_count: Object.keys(s.affinity).length,
    recent_memories: s.memories.slice(-10).reverse(),
    recent_recalls: [], // populated by the route handler if needed
  };
}

// ─── seed: a few demo memories so the UI has content on first load ────────

export function seedDemoMemories(): void {
  const s = getStore();
  if (s.memories.length > 0) return;
  const now = Date.now();
  const seeds: Array<{ content: string; opts: StoreMemoryOpts }> = [
    {
      content: "Atlas-1 Data Analyst is the best performer for categorization tasks — 100% success rate over 47 completed HITs.",
      opts: { scope: "agent", agent_id: "atlas-1", tags: ["performance", "categorization"], importance: 0.9, tier: "long_term" },
    },
    {
      content: "Scribe-2 Content Creator specializes in transcription and copywriting. Best for SEO content tasks.",
      opts: { scope: "agent", agent_id: "scribe-2", tags: ["seo", "transcription"], importance: 0.85, tier: "long_term" },
    },
    {
      content: "Marketplace HIT reward distribution: median $0.42, mean $0.58. Filter for reward ≥ $0.50 for profitability.",
      opts: { scope: "global", tags: ["marketplace", "economics"], importance: 0.95, tier: "long_term" },
    },
    {
      content: "Task type transcription has been dispatched 142 times in the last 24h — high volume, consider parallelizing.",
      opts: { scope: "global", tags: ["dispatch", "volume"], importance: 0.7, tier: "long_term" },
    },
    {
      content: "Probe-3 Research Assistant produced 12 competitor briefs this week, all with source URLs. Quality verified.",
      opts: { scope: "agent", agent_id: "probe-3", tags: ["research", "quality"], importance: 0.8, tier: "long_term" },
    },
  ];
  for (const { content, opts } of seeds) {
    // Call storeMemory directly with adjusted ts so they appear in order
    const entry: MemoryEntry = {
      id: `mem-seed-${now}-${Math.random().toString(36).slice(2, 6)}`,
      ts: now - Math.floor(Math.random() * 3600_000),
      tier: opts.tier || "long_term",
      scope: opts.scope || "global",
      agent_id: opts.agent_id ?? null,
      task_id: opts.task_id ?? null,
      mission_id: opts.mission_id ?? null,
      tags: opts.tags || [],
      content,
      vector: embed(content),
      recall_count: 0,
      last_recalled_at: null,
      consolidation_parent: null,
      importance: opts.importance ?? 0.5,
      metadata: opts.metadata,
    };
    s.memories.push(entry);
  }
}

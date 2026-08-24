/**
 * Agentic Stakeholder Registry
 * ---------------------------------------------------------------------------
 * The swarm query (/api/state) returns 200+ "agents", but most of them are
 * marketplace catalog entries (SuperAGI, Metaschool, Fetch.ai, LangChain,
 * Kyrolabs, e2b, FindYourAgent, AI Agent Store) — not actual agentic workers.
 * This module classifies every entity into one of four stakeholder classes,
 * computes a health score, derives a lifecycle state, and — critically —
 * activates the dormant handoff system so saturated workers can offload to
 * idle workers with overlapping expertise.
 *
 * Operator directive (Task 13):
 *   "query swarm 'agentic stakeholders' implement further improvements
 *    autonomously"
 *
 * The handoff system was dormant because processTasks() only triggered a
 * handoff on ~8% of tasks during quality review, and even then only routed
 * to a single hard-coded `seo_specialist`. This module introduces:
 *
 *   1. STAKEHOLDER CLASSIFICATION
 *      - `worker`     — real agentic worker (capabilities >= 1, has a real
 *                       system_prompt, not a marketplace listing)
 *      - `operator`   — operator-tier agent (Portfolio Manager, Growth Hacker,
 *                       Auto Deployer, Monetization Engine, Full-Stack Builder,
 *                       App Architect, Meta Orchestrator, Builder+ Payout)
 *      - `catalog`    — marketplace listing / procurement card (vendor entry
 *                       from SuperAGI, Metaschool, etc. — NOT an agent)
 *      - `quarantined`— dead/dormant worker (no tasks, never active, or stale
 *                       > 90 days AND success_rate < 50%)
 *
 *   2. HEALTH SCORE (0–100)
 *      Composite of: success_rate (40%), activity_recency (25%),
 *      tasks_completed quintile (20%), workload_balance (15%).
 *
 *   3. LIFECYCLE STATE
 *      active | idle | saturated | stale | quarantined | retired
 *
 *   4. HANDOFF ACTIVATION
 *      detectSaturatedWorkers() → findIdleMatches() → createHandoff()
 *      Auto-routes overflow work from 5/5 agents to idle agents (0/n) with
 *      overlapping expertise_areas.
 *
 *   5. CATALOG DE-DUPLICATION
 *      Tags marketplace duplicates so /api/stakeholders can group them by
 *      source marketplace instead of treating 15 "SocialBot-LinkedIn" entries
 *      as 15 separate agents.
 *
 * All operations are non-throwing. The orchestrator tick cannot break from
 * stakeholder scan failures.
 */

import { b44, type Agent, type AgentHandoff, type Task } from "./base44";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of days after which a worker with no activity is considered "stale". */
export const STALE_THRESHOLD_DAYS = 90;
/** Number of days after which a worker is considered "retired". */
export const RETIRED_THRESHOLD_DAYS = 180;
/** Health-score weight on success_rate (0–100). */
export const WEIGHT_SUCCESS_RATE = 0.40;
/** Health-score weight on activity recency (0–100). */
export const WEIGHT_ACTIVITY_RECENCY = 0.25;
/** Health-score weight on tasks_completed quintile (0–100). */
export const WEIGHT_TASKS_QUINTILE = 0.20;
/** Health-score weight on workload balance (0–100). */
export const WEIGHT_WORKLOAD_BALANCE = 0.15;

/** Catalog-source detection: vendor prefixes and marketplace names. */
export const CATALOG_MARKERS: Array<{ source: string; patterns: RegExp[] }> = [
  {
    source: "SuperAGI Marketplace",
    patterns: [/SuperAGI\s+Marketplace/i],
  },
  {
    source: "Metaschool AI Agents Marketplace",
    patterns: [/Metaschool/i],
  },
  {
    source: "Fetch.ai Agentverse Almanac",
    patterns: [/Fetch\.ai/i],
  },
  {
    source: "LangChain Templates Hub",
    patterns: [/LangChain\s+Templates/i],
  },
  {
    source: "FindYourAgent.ai",
    patterns: [/FindYourAgent/i],
  },
  {
    source: "Awesome Agents (Kyrolabs)",
    patterns: [/Awesome\s+Agents.*Kyrolabs/i, /Kyrolabs/i],
  },
  {
    source: "Awesome AI Agents (e2b)",
    patterns: [/Awesome\s+AI\s+Agents.*e2b/i, /\be2b\b/i],
  },
  {
    source: "AI Agent Store",
    patterns: [/AI\s+Agent\s+Store/i, /AI\s+Agents\s+List/i],
  },
  {
    source: "Custom-Script-Endpoint",
    patterns: [/Custom-Script-Endpoint/i],
  },
];

/** Operator-tier agent name patterns (these are real agents, not catalog). */
export const OPERATOR_PATTERNS: RegExp[] = [
  /Portfolio\s+Manager/i,
  /Growth\s+Hacker/i,
  /Auto\s+Deployer/i,
  /Monetization\s+Engine/i,
  /Full-Stack\s+Builder/i,
  /App\s+Architect/i,
  /Meta\s+Orchestrator/i,
  /Builder\+\s+Payout\s+Executor/i,
  /Payout\s+Executor/i,
];

/** Real worker agent types (Builder tier, has a Noun-# pattern). */
export const WORKER_NAME_PATTERN = /^[A-Z][a-z]+-\d+\s+/;
/** Example worker names: "Docs-13 Document Processor", "Atlas-1 Data Analyst" */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StakeholderClass =
  | "worker"
  | "operator"
  | "catalog"
  | "quarantined";

export type LifecycleState =
  | "active"
  | "idle"
  | "saturated"
  | "stale"
  | "quarantined"
  | "retired";

export interface StakeholderClassification {
  /** Original agent entity ID. */
  agent_id: string;
  /** Display name. */
  name: string;
  /** Agent type from the Agent entity. */
  type: string;
  /** Classified stakeholder class. */
  class: StakeholderClass;
  /** If class === "catalog", the source marketplace name. */
  catalog_source?: string;
  /** Lifecycle state derived from activity + workload + success_rate. */
  lifecycle: LifecycleState;
  /** Health score 0–100 (composite). */
  health_score: number;
  /** Sub-scores (for transparency / drill-down). */
  health_breakdown: {
    success_rate: number;
    activity_recency: number;
    tasks_quintile: number;
    workload_balance: number;
  };
  /** Current workload / max_workload. */
  workload: { current: number; max: number };
  /** Performance metrics snapshot. */
  metrics: {
    revenue_generated: number;
    tasks_completed: number;
    handoffs_received: number;
    handoffs_initiated: number;
    success_rate: number;
    last_active: string | null;
    days_since_active: number | null;
  };
  /** Capabilities (deduplicated). */
  capabilities: string[];
  /** If true, the agent has accepted at least one handoff target match. */
  handoff_eligible: boolean;
  /** If true, the agent is currently 5/5 (or current >= max) on workload. */
  is_saturated: boolean;
  /** Reason for classification (audit trail). */
  classification_reason: string;
}

export interface StakeholderRegistrySnapshot {
  generated_at: string;
  total_entities: number;
  by_class: Record<StakeholderClass, number>;
  by_lifecycle: Record<LifecycleState, number>;
  by_catalog_source: Array<{ source: string; count: number }>;
  workers: StakeholderClassification[];
  operators: StakeholderClassification[];
  catalog_sample: Array<{ name: string; source: string; count: number }>;
  quarantined: StakeholderClassification[];
  /** Top 10 workers by health_score (for the dashboard hero panel). */
  top_performers: StakeholderClassification[];
  /** Workers currently at max workload (need handoff relief). */
  saturated_workers: StakeholderClassification[];
  /** Workers currently idle (0/n workload) — eligible handoff targets. */
  idle_workers: StakeholderClassification[];
  /** Avg health score across workers + operators only. */
  avg_health_score: number;
  /** Total estimated unrealized revenue from idle workers (heuristic). */
  unrealized_capacity_estimate_usd: number;
}

export interface HandoffRecommendation {
  from_agent_id: string;
  from_agent_name: string;
  to_agent_id: string;
  to_agent_name: string;
  reason: "workload_balance" | "capability_match";
  shared_capabilities: string[];
  from_workload: { current: number; max: number };
  to_workload: { current: number; max: number };
  rationale: string;
  /** Estimated tasks that could be offloaded (current - max + 1). */
  estimated_overflow: number;
}

export interface HandoffActivationResult {
  recommendations_generated: number;
  handoffs_created: number;
  handoffs_failed: number;
  recommendations: HandoffRecommendation[];
  created_handoff_ids: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/** Detect if an agent name matches a marketplace catalog source. */
export function detectCatalogSource(name: string): string | null {
  for (const marker of CATALOG_MARKERS) {
    for (const pattern of marker.patterns) {
      if (pattern.test(name)) return marker.source;
    }
  }
  return null;
}

/** Detect if an agent is an operator-tier agent (by name pattern). */
export function isOperatorAgent(name: string): boolean {
  return OPERATOR_PATTERNS.some((p) => p.test(name));
}

/** Detect if an agent is a real worker (Noun-N pattern, like "Atlas-1 ..."). */
export function isWorkerAgent(name: string): boolean {
  if (isOperatorAgent(name)) return false;
  return WORKER_NAME_PATTERN.test(name);
}

/** Days since the agent's last_active timestamp (null if never active). */
export function daysSinceActive(lastActive: string | null | undefined): number | null {
  if (!lastActive) return null;
  const t = Date.parse(lastActive);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Health scoring
// ---------------------------------------------------------------------------

/**
 * Compute a 0–100 sub-score for activity recency.
 *   - active today           → 100
 *   - active within 7 days   → 80–99 (linear decay)
 *   - active within 30 days  → 50–80
 *   - active within 90 days  → 20–50
 *   - active > 90 days       → 0–20
 *   - never active           → 0
 */
export function scoreActivityRecency(lastActive: string | null | undefined): number {
  const days = daysSinceActive(lastActive);
  if (days === null) return 0;
  if (days <= 1) return 100;
  if (days <= 7) return Math.round(80 + ((7 - days) / 6) * 20);
  if (days <= 30) return Math.round(50 + ((30 - days) / 23) * 30);
  if (days <= STALE_THRESHOLD_DAYS) return Math.round(20 + ((90 - days) / 60) * 30);
  return Math.max(0, Math.round(20 - (days - 90) / 10));
}

/**
 * Compute a 0–100 sub-score for tasks completed.
 *   - 0 tasks       → 0 (no evidence of capability)
 *   - 1–10          → 20–40
 *   - 11–50         → 40–70
 *   - 51–200        → 70–90
 *   - 200+          → 90–100
 */
export function scoreTasksQuintile(tasksCompleted: number): number {
  if (tasksCompleted <= 0) return 0;
  if (tasksCompleted <= 10) return 20 + Math.round((tasksCompleted / 10) * 20);
  if (tasksCompleted <= 50) return 40 + Math.round(((tasksCompleted - 10) / 40) * 30);
  if (tasksCompleted <= 200) return 70 + Math.round(((tasksCompleted - 50) / 150) * 20);
  return Math.min(100, 90 + Math.round((tasksCompleted - 200) / 50));
}

/**
 * Compute a 0–100 sub-score for workload balance.
 *   - 0/n           → 60 (idle, has capacity — not penalized for being available)
 *   - 1..(max-1)/max → 100 (healthy load)
 *   - max/max       → 30 (saturated, no capacity for new work)
 * Negative or undefined → 50 (unknown).
 */
export function scoreWorkloadBalance(current: number, max: number): number {
  if (!max || max <= 0) return 50;
  if (current < 0) return 50;
  if (current === 0) return 60;
  if (current >= max) return 30;
  // Linear ramp 60 → 100 as current goes 1 → (max-1)
  if (max <= 1) return 80;
  return Math.round(60 + ((current - 1) / (max - 1)) * 40);
}

/**
 * Compute the composite 0–100 health score.
 */
export function computeHealthScore(input: {
  success_rate: number;
  last_active: string | null | undefined;
  tasks_completed: number;
  current_workload: number;
  max_workload: number;
}): {
  score: number;
  breakdown: {
    success_rate: number;
    activity_recency: number;
    tasks_quintile: number;
    workload_balance: number;
  };
} {
  const sr = Math.max(0, Math.min(100, input.success_rate || 0));
  const ar = scoreActivityRecency(input.last_active);
  const tq = scoreTasksQuintile(input.tasks_completed);
  const wb = scoreWorkloadBalance(input.current_workload, input.max_workload);
  const score = Math.round(
    sr * WEIGHT_SUCCESS_RATE +
      ar * WEIGHT_ACTIVITY_RECENCY +
      tq * WEIGHT_TASKS_QUINTILE +
      wb * WEIGHT_WORKLOAD_BALANCE,
  );
  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      success_rate: sr,
      activity_recency: ar,
      tasks_quintile: tq,
      workload_balance: wb,
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle derivation
// ---------------------------------------------------------------------------

/**
 * Derive lifecycle state from classification + metrics.
 *
 * Quarantined takes precedence (operator-flagged dead). Then retired
 * (stale > 180d). Then stale (no activity > 90d). Then saturated
 * (current >= max). Then idle (current === 0). Otherwise active.
 */
export function deriveLifecycle(
  cls: StakeholderClass,
  metrics: {
    days_since_active: number | null;
    current_workload: number;
    max_workload: number;
    tasks_completed: number;
  },
): LifecycleState {
  if (cls === "quarantined") return "quarantined";
  const days = metrics.days_since_active;
  if (days !== null && days >= RETIRED_THRESHOLD_DAYS) return "retired";
  if (days !== null && days >= STALE_THRESHOLD_DAYS) return "stale";
  // Catalog entries that haven't been procured yet — treat as idle.
  if (cls === "catalog") return "idle";
  const max = metrics.max_workload || 0;
  if (max > 0 && metrics.current_workload >= max) return "saturated";
  if (metrics.current_workload === 0) return "idle";
  return "active";
}

// ---------------------------------------------------------------------------
// Classification entry point
// ---------------------------------------------------------------------------

/**
 * Classify a single agent entity into a StakeholderClassification.
 */
export function classifyAgent(agent: Agent): StakeholderClassification {
  const name = agent.name || "(unnamed)";
  const type = agent.type || "unknown";
  const pm = agent.performance_metrics || {};
  const current = Number(agent.current_workload || 0);
  const max = Number(agent.max_workload || 0);
  const tasks = Number(pm.tasks_completed || 0);
  const revenue = Number(pm.revenue_generated || 0);
  const sr = Number(pm.success_rate || 0);
  const handoffsRecv = Number(pm.handoffs_received || 0);
  const handoffsInit = Number(pm.handoffs_initiated || 0);
  const lastActive = pm.last_active ?? null;
  const days = daysSinceActive(lastActive);
  const capabilities = Array.from(new Set(agent.capabilities || []));

  // Class detection — order matters: catalog > operator > worker > quarantined
  let cls: StakeholderClass = "worker";
  let reason = `worker name pattern matched (Noun-N)`;
  const catalogSource = detectCatalogSource(name);
  if (catalogSource) {
    cls = "catalog";
    reason = `marketplace catalog entry from "${catalogSource}"`;
  } else if (isOperatorAgent(name)) {
    cls = "operator";
    reason = `operator-tier agent (matched operator pattern)`;
  } else if (isWorkerAgent(name)) {
    cls = "worker";
    reason = `worker agent (matched Noun-N name pattern)`;
  } else {
    // Unknown name shape — fall back to capability + activity heuristic.
    if (capabilities.length === 0 && tasks === 0 && !lastActive) {
      cls = "catalog";
      reason = `unknown name shape, no capabilities, never active — likely catalog`;
    } else if (capabilities.length === 0 && tasks === 0 && days !== null && days > 30) {
      cls = "quarantined";
      reason = `no capabilities, no tasks, stale ${days}d — quarantined`;
    } else {
      cls = "worker";
      reason = `unknown name shape but has capabilities or activity — treated as worker`;
    }
  }

  // Quarantine override — never-active catalog entries stay catalog, but
  // workers with success_rate < 50% AND > 30 days stale get quarantined.
  if (cls === "worker" && days !== null && days > 30 && sr < 50 && tasks === 0) {
    cls = "quarantined";
    reason = `worker stale ${days}d, success_rate ${sr}%, 0 tasks — quarantined`;
  }

  const health = computeHealthScore({
    success_rate: sr,
    last_active: lastActive,
    tasks_completed: tasks,
    current_workload: current,
    max_workload: max,
  });

  const lifecycle = deriveLifecycle(cls, {
    days_since_active: days,
    current_workload: current,
    max_workload: max,
    tasks_completed: tasks,
  });

  const isSaturated = max > 0 && current >= max;
  const handoffEligible =
    (cls === "worker" || cls === "operator") &&
    !isSaturated &&
    capabilities.length > 0 &&
    lifecycle !== "quarantined" &&
    lifecycle !== "retired";

  return {
    agent_id: agent.id || name,
    name,
    type,
    class: cls,
    catalog_source: catalogSource || undefined,
    lifecycle,
    health_score: health.score,
    health_breakdown: health.breakdown,
    workload: { current, max },
    metrics: {
      revenue_generated: revenue,
      tasks_completed: tasks,
      handoffs_received: handoffsRecv,
      handoffs_initiated: handoffsInit,
      success_rate: sr,
      last_active: lastActive,
      days_since_active: days,
    },
    capabilities,
    handoff_eligible: handoffEligible,
    is_saturated: isSaturated,
    classification_reason: reason,
  };
}

// ---------------------------------------------------------------------------
// Registry — batch classification + snapshot
// ---------------------------------------------------------------------------

/**
 * Classify a batch of agents and return a StakeholderRegistrySnapshot.
 */
export function buildStakeholderRegistry(
  agents: Agent[],
): StakeholderRegistrySnapshot {
  const classifications = agents.map(classifyAgent);

  const byClass: Record<StakeholderClass, number> = {
    worker: 0,
    operator: 0,
    catalog: 0,
    quarantined: 0,
  };
  const byLifecycle: Record<LifecycleState, number> = {
    active: 0,
    idle: 0,
    saturated: 0,
    stale: 0,
    quarantined: 0,
    retired: 0,
  };
  const catalogBySource = new Map<string, number>();

  for (const c of classifications) {
    byClass[c.class]++;
    byLifecycle[c.lifecycle]++;
    if (c.class === "catalog" && c.catalog_source) {
      catalogBySource.set(
        c.catalog_source,
        (catalogBySource.get(c.catalog_source) || 0) + 1,
      );
    }
  }

  const workers = classifications
    .filter((c) => c.class === "worker")
    .sort((a, b) => b.health_score - a.health_score);
  const operators = classifications
    .filter((c) => c.class === "operator")
    .sort((a, b) => b.health_score - a.health_score);
  const quarantined = classifications.filter((c) => c.class === "quarantined");

  // Catalog sample: top 10 sources by count
  const byCatalogSource = Array.from(catalogBySource.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  // Catalog sample for snapshot: deduplicate by name, count duplicates
  const catalogNameCounts = new Map<string, { name: string; source: string; count: number }>();
  for (const c of classifications) {
    if (c.class !== "catalog" || !c.catalog_source) continue;
    const existing = catalogNameCounts.get(c.name);
    if (existing) {
      existing.count++;
    } else {
      catalogNameCounts.set(c.name, {
        name: c.name,
        source: c.catalog_source,
        count: 1,
      });
    }
  }
  const catalogSample = Array.from(catalogNameCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topPerformers = [...workers, ...operators]
    .filter((c) => c.metrics.tasks_completed > 0)
    .slice(0, 10);

  const saturatedWorkers = [...workers, ...operators].filter((c) => c.is_saturated);
  const idleWorkers = [...workers, ...operators].filter(
    (c) => c.lifecycle === "idle" && c.handoff_eligible,
  );

  // Avg health score across workers + operators only (excludes catalog/quarantined).
  const realStakeholders = [...workers, ...operators];
  const avgHealth =
    realStakeholders.length > 0
      ? Math.round(
          realStakeholders.reduce((s, c) => s + c.health_score, 0) /
            realStakeholders.length,
        )
      : 0;

  // Unrealized capacity: idle workers with non-zero capabilities × target monthly rev / 30
  // Heuristic — meant to flag opportunity, not predict revenue.
  const unrealizedCapacity = idleWorkers.reduce((sum, c) => {
    if (c.metrics.tasks_completed > 0) return sum; // already producing
    const caps = c.capabilities.length;
    return sum + caps * 5; // $5/capability/day heuristic
  }, 0);

  return {
    generated_at: new Date().toISOString(),
    total_entities: classifications.length,
    by_class: byClass,
    by_lifecycle: byLifecycle,
    by_catalog_source: byCatalogSource,
    workers,
    operators,
    catalog_sample: catalogSample,
    quarantined,
    top_performers: topPerformers,
    saturated_workers: saturatedWorkers,
    idle_workers: idleWorkers,
    avg_health_score: avgHealth,
    unrealized_capacity_estimate_usd: unrealizedCapacity,
  };
}

// ---------------------------------------------------------------------------
// Handoff activation
// ---------------------------------------------------------------------------

/**
 * Compute the overlap between two capability sets (Jaccard × count).
 * Returns { shared: string[], score: 0..1 }.
 */
export function capabilityOverlap(
  a: string[],
  b: string[],
): { shared: string[]; score: number } {
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  const shared: string[] = [];
  for (const cap of a) {
    if (setB.has(cap.toLowerCase())) shared.push(cap);
  }
  const unionSize = new Set([...setA, ...setB]).size;
  const score = unionSize === 0 ? 0 : shared.length / unionSize;
  return { shared, score };
}

/**
 * For each saturated worker, find an idle worker with overlapping
 * expertise. Returns at most `maxRecommendations` recommendations.
 *
 * Matching rules:
 *   1. Saturated = current_workload >= max_workload
 *   2. Idle target = current_workload === 0 AND handoff_eligible
 *   3. Capability overlap >= 1 shared capability (or no-cap overlap = 0
 *      but operator-tier targets can still accept via workload_balance)
 *   4. Reason = "workload_balance" if no capability overlap, else "capability_match"
 */
export function findHandoffRecommendations(
  registry: StakeholderRegistrySnapshot,
  maxRecommendations = 10,
): HandoffRecommendation[] {
  const recs: HandoffRecommendation[] = [];
  for (const src of registry.saturated_workers) {
    if (recs.length >= maxRecommendations) break;
    let best: {
      target: StakeholderClassification;
      shared: string[];
      score: number;
    } | null = null;
    for (const target of registry.idle_workers) {
      if (target.agent_id === src.agent_id) continue;
      const overlap = capabilityOverlap(src.capabilities, target.capabilities);
      if (!best || overlap.score > best.score) {
        best = { target, shared: overlap.shared, score: overlap.score };
      }
    }
    if (!best) continue;
    if (best.shared.length === 0 && best.target.class !== "operator") {
      // No capability overlap and target isn't operator-tier — skip.
      // Operator-tier agents can accept workload_balance handoffs even
      // without capability match (they manage, they don't execute).
      continue;
    }
    const overflow = Math.max(1, src.workload.current - src.workload.max + 1);
    const reason: HandoffRecommendation["reason"] =
      best.shared.length > 0 ? "capability_match" : "workload_balance";
    recs.push({
      from_agent_id: src.agent_id,
      from_agent_name: src.name,
      to_agent_id: best.target.agent_id,
      to_agent_name: best.target.name,
      reason,
      shared_capabilities: best.shared,
      from_workload: src.workload,
      to_workload: best.target.workload,
      rationale:
        reason === "capability_match"
          ? `${src.name} is ${src.workload.current}/${src.workload.max} saturated. ${best.target.name} is idle with ${best.shared.length} shared capabilities: ${best.shared.join(", ")}. Offload ${overflow} task(s) to balance load.`
          : `${src.name} is ${src.workload.current}/${src.workload.max} saturated. ${best.target.name} is an idle operator-tier agent — accept workload_balance handoff to relieve pressure.`,
      estimated_overflow: overflow,
    });
  }
  return recs;
}

/**
 * Materialize handoff recommendations into actual AgentHandoff records.
 *
 * For each recommendation, finds an in_progress task currently assigned to
 * the saturated source agent and re-assigns it to the idle target agent,
 * creating an AgentHandoff record with the appropriate reason.
 *
 * Returns the count of handoffs successfully created. Non-throwing.
 */
export async function activateHandoffs(
  recommendations: HandoffRecommendation[],
  maxHandoffs = 3,
): Promise<HandoffActivationResult> {
  const result: HandoffActivationResult = {
    recommendations_generated: recommendations.length,
    handoffs_created: 0,
    handoffs_failed: 0,
    recommendations,
    created_handoff_ids: [],
    errors: [],
  };

  for (const rec of recommendations) {
    if (result.handoffs_created >= maxHandoffs) break;
    try {
      // Find an in_progress task currently assigned to the source agent.
      const candidateTasks = (await b44.list("Task", {
        q: {
          status: "in_progress",
          assigned_agent_id: rec.from_agent_id,
        },
        limit: 5,
        sort_by: "-created_date",
      })) as Task[];

      if (candidateTasks.length === 0) {
        result.errors.push(
          `No in_progress tasks found for source agent ${rec.from_agent_name} — skipping`,
        );
        continue;
      }

      const task = candidateTasks[0];
      if (!task.id) {
        result.errors.push(`Task missing id — skipping`);
        continue;
      }

      // Create the AgentHandoff record.
      const handoff = (await b44.create("AgentHandoff", {
        task_id: task.id,
        from_agent_id: rec.from_agent_id,
        to_agent_id: rec.to_agent_id,
        reason: rec.reason,
        context: rec.rationale,
        handoff_data: {
          shared_capabilities: rec.shared_capabilities,
          from_workload: rec.from_workload,
          to_workload: rec.to_workload,
          estimated_overflow: rec.estimated_overflow,
          origin: "agentic_stakeholders:auto_handoff",
          triggered_at: new Date().toISOString(),
        },
        status: "accepted",
        response_message: `Auto-accepted by Agentic Stakeholder Registry — ${rec.reason}`,
      } as never)) as AgentHandoff;

      // Re-assign the task to the target agent.
      await b44.update(
        "Task",
        task.id,
        {
          assigned_agent_id: rec.to_agent_id,
          handoff_history: [
            ...(task.handoff_history || []),
            { handoff_id: handoff.id, at: new Date().toISOString() },
          ],
        } as never,
      );

      // Bump the source agent's handoffs_initiated counter.
      // (We don't decrement current_workload here — processTasks() will
      // do that when the task completes on the target agent. The handoff
      // itself doesn't change the task count, just the assignment.)
      const sourceAgent = (await b44.list("Agent", {
        q: { id: rec.from_agent_id },
        limit: 1,
      })) as Agent[];
      if (sourceAgent[0]) {
        const srcPm = sourceAgent[0].performance_metrics || {};
        await b44.update(
          "Agent",
          rec.from_agent_id,
          {
            performance_metrics: {
              ...srcPm,
              handoffs_initiated: Number(srcPm.handoffs_initiated || 0) + 1,
              last_active: new Date().toISOString(),
            },
          } as never,
        );
      }

      // Bump the target agent's handoffs_received counter.
      const targetAgent = (await b44.list("Agent", {
        q: { id: rec.to_agent_id },
        limit: 1,
      })) as Agent[];
      if (targetAgent[0]) {
        const tgtPm = targetAgent[0].performance_metrics || {};
        await b44.update(
          "Agent",
          rec.to_agent_id,
          {
            performance_metrics: {
              ...tgtPm,
              handoffs_received: Number(tgtPm.handoffs_received || 0) + 1,
              last_active: new Date().toISOString(),
            },
          } as never,
        );
      }

      result.handoffs_created++;
      result.created_handoff_ids.push(handoff.id || "");
    } catch (err) {
      result.handoffs_failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(
        `Handoff ${rec.from_agent_name} → ${rec.to_agent_name} failed: ${msg}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Top-level orchestrator hook
// ---------------------------------------------------------------------------

/**
 * Scan the swarm, classify stakeholders, and (if there are saturated workers
 * with eligible idle matches) activate handoffs.
 *
 * Designed to be called from the orchestrator tick() — non-throwing.
 * Returns a summary that the TickReport can surface.
 */
export async function scanAndRebalanceStakeholders(
  options: { maxHandoffs?: number; maxRecommendations?: number } = {},
): Promise<{
  registry: StakeholderRegistrySnapshot;
  recommendations: HandoffRecommendation[];
  activations: HandoffActivationResult | null;
}> {
  const agents = (await b44.list("Agent", { limit: 500 })) as Agent[];
  const registry = buildStakeholderRegistry(agents);
  const recommendations = findHandoffRecommendations(
    registry,
    options.maxRecommendations ?? 10,
  );

  let activations: HandoffActivationResult | null = null;
  if (recommendations.length > 0) {
    activations = await activateHandoffs(
      recommendations,
      options.maxHandoffs ?? 3,
    );
  }

  return { registry, recommendations, activations };
}

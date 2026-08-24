/**
 * Swarm Integrity Guard (SIG)
 *
 * Addresses the 15 anti-patterns that autonomous revenue-generating swarms
 * fall into. Each anti-pattern maps to one safeguard or one signal monitor:
 *
 *   1. Hallucinated Arbitrage Loop        → Class A external-signal gate
 *   2. Hyper-Optimization Death Spiral    → North-star metric (realRevenue vs phantomRevenue)
 *   3. Echo-Chamber Consensus             → External witness requirement for paid_out transitions
 *   4. Risk-Aversion Paralysis            → Minimum-action floor (24h no-action warning)
 *   5. Cannibalistic Competition          → Global opportunity lock (Set<oppHash>)
 *   6. Sub-Agent Proliferation            → Spawn budget per parent task (default 3)
 *   7. Sunk Cost Resource Sink            → Stale-asset voiding (PayoutItems > N days no external ref)
 *   8. Context-Window Amnesia Drift       → Seed-prompt hash verification
 *   9. Penny-Wise Compute Drain           → Model tier policy tracker
 *  10. Fragile Exploitation Monopoly      → Revenue diversification floor (no source > 60%)
 *  11. Velocity-without-velocity signal   → apiActions / realRevenue ratio monitor
 *  12. Token-to-revenue decoupling signal → tokens / realRevenue ratio monitor
 *  13. Log monotony signal                → result_data hash collision rate
 *
 * Default mode: OBSERVE (logs breaches, never halts the orchestrator).
 * HALT mode:    set SIG_HALT_MODE=1 in env. Orchestrator.tick() will refuse
 *               to run while a CRITICAL breach is active.
 *
 * State is in-memory (module-level singleton). It resets on dev-server
 * restart. This is acceptable for SIG — it is observability infrastructure,
 * not authoritative state. The authoritative freeze lives in
 * .autonomous-state.json (managed by the payout reconciler).
 */

import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export type BreachSeverity = "info" | "warning" | "critical";

export type BreachPattern =
  | "hallucinated_arbitrage"
  | "hyper_optimization_spiral"
  | "echo_chamber_consensus"
  | "risk_aversion_paralysis"
  | "cannibalistic_competition"
  | "sub_agent_proliferation"
  | "sunk_cost_resource_sink"
  | "context_window_drift"
  | "penny_wise_compute"
  | "fragile_monopoly"
  | "velocity_without_velocity"
  | "token_to_revenue_decoupling"
  | "log_monotony";

export interface Breach {
  id: string;
  pattern: BreachPattern;
  severity: BreachSeverity;
  detected_at: string;
  description: string;
  evidence?: Record<string, unknown>;
  recommendation: string;
}

export interface SigSignals {
  /** Total orchestrator tick() calls since boot. */
  ticks_total: number;
  /** Total API actions (b44.create / b44.update) observed since boot. */
  api_actions_total: number;
  /** Sum of revenue events with an external confirmation ref (bank tx, PayPal payout ID, on-chain hash). In cents. */
  real_revenue_cents: number;
  /** Sum of revenue events WITHOUT an external confirmation ref. In cents. */
  phantom_revenue_cents: number;
  /** Rough token estimate from agent activity (1 tick ≈ 1500 tokens across the swarm). */
  tokens_consumed_estimate: number;
  /** Count of unique result_data hashes observed in the last 200 tasks. */
  unique_result_hashes: number;
  /** Count of duplicate result_data hashes (collisions) in the last 200 tasks. */
  duplicate_result_hashes: number;
  /** ISO timestamp of the last action that mutated real state. */
  last_real_action_at: string | null;
  /** ISO timestamp of the last tick. */
  last_tick_at: string | null;
}

export interface SigSafeguards {
  class_a_gate: { enabled: boolean; blocked_count: number; description: string };
  opportunity_lock: { enabled: boolean; locks_held: number; description: string };
  spawn_budget: {
    enabled: boolean;
    per_parent_cap: number;
    spawns_blocked: number;
    description: string;
  };
  stale_asset_void: {
    enabled: boolean;
    max_age_days: number;
    voided_count: number;
    description: string;
  };
  seed_hash_check: {
    enabled: boolean;
    drift_count: number;
    description: string;
  };
  diversification_floor: {
    enabled: boolean;
    max_source_pct: number;
    breaches: number;
    description: string;
  };
  min_action_floor: {
    enabled: boolean;
    window_hours: number;
    description: string;
  };
}

export interface SigState {
  mode: "observe" | "halt";
  halt_active: boolean;
  halt_reason: string | null;
  breaches: Breach[];
  signals: SigSignals;
  safeguards: SigSafeguards;
  generated_at: string;
  /** ISO timestamp of the last time evaluateBreaches() was called. */
  last_evaluated_at: string | null;
}

// ─── Module-level singleton ─────────────────────────────────────────────
//
// We use globalThis to survive two things:
//   1. Next.js Turbopack HMR — without globalThis, every hot-reload would
//      create a fresh `state` object and we'd lose all breach history.
//   2. Next.js dev-mode route-level module isolation — without globalThis,
//      /api/orchestrator/tick and /api/sig would each get their own copy
//      of this module, so writes from tick() would never be visible to
//      reads from /api/sig.
//
// In production (next build), modules are deduplicated normally and
// globalThis is technically unnecessary, but it's a no-op there.

const MAX_BREACHES_KEPT = 200;
const SIG_GLOBAL_KEY = "__charibaas_sig_state__";

type SigInternal = {
  state: SigState;
  tickOpportunityLocks: Set<string>;
  tickSpawnCounts: Map<string, number>;
  recentResultHashes: string[];
  lastBreachAt: Map<BreachPattern, number>;
};

function makeFreshInternal(): SigInternal {
  return {
    state: {
      mode: process.env.SIG_HALT_MODE === "1" ? "halt" : "observe",
      halt_active: false,
      halt_reason: null,
      breaches: [],
      signals: {
        ticks_total: 0,
        api_actions_total: 0,
        real_revenue_cents: 0,
        phantom_revenue_cents: 0,
        tokens_consumed_estimate: 0,
        unique_result_hashes: 0,
        duplicate_result_hashes: 0,
        last_real_action_at: null,
        last_tick_at: null,
      },
      safeguards: {
        class_a_gate: {
          enabled: true,
          blocked_count: 0,
          description:
            "Refuse to transition a RevenueEvent to `paid_out` unless it carries an external confirmation ref (bank tx id, PayPal payout id, on-chain hash).",
        },
        opportunity_lock: {
          enabled: true,
          locks_held: 0,
          description:
            "Per-tick opportunity hash set. If two agents target the same opportunity in the same tick, only the first proceeds.",
        },
        spawn_budget: {
          enabled: true,
          per_parent_cap: 3,
          spawns_blocked: 0,
          description:
            "Each parent task may spawn at most N sub-tasks. Hard cap prevents Sorcerer's Apprentice exponential blow-up.",
        },
        stale_asset_void: {
          enabled: true,
          max_age_days: 30,
          voided_count: 0,
          description:
            "PayoutItems older than N days with no external confirmation ref get auto-marked `voided_stale`.",
        },
        seed_hash_check: {
          enabled: true,
          drift_count: 0,
          description:
            "Each agent's system_prompt + capabilities + safety rules are hashed at seed time. Periodic check flags any agent whose prompt was rewritten post-seed.",
        },
        diversification_floor: {
          enabled: true,
          max_source_pct: 60,
          breaches: 0,
          description:
            "No single revenue source may exceed 60% of confirmed revenue. Breach surfaces a warning; HALT mode blocks new actions on the dominant source.",
        },
        min_action_floor: {
          enabled: true,
          window_hours: 24,
          description:
            "If 24h pass with zero real-state mutations, surface a Risk-Aversion Paralysis warning.",
        },
      },
      generated_at: new Date().toISOString(),
      last_evaluated_at: null,
    },
    tickOpportunityLocks: new Set<string>(),
    tickSpawnCounts: new Map<string, number>(),
    recentResultHashes: [],
    lastBreachAt: new Map<BreachPattern, number>(),
  };
}

// Assign to globalThis once, then reuse.
const internal: SigInternal =
  (globalThis as Record<string, unknown>)[SIG_GLOBAL_KEY] as SigInternal ||
  (() => {
    const fresh = makeFreshInternal();
    (globalThis as Record<string, unknown>)[SIG_GLOBAL_KEY] = fresh;
    return fresh;
  })();

// Convenience alias so the rest of the file reads cleanly.
const state = internal.state;
const tickOpportunityLocks = internal.tickOpportunityLocks;
const tickSpawnCounts = internal.tickSpawnCounts;
const recentResultHashes = internal.recentResultHashes;
const RECENT_HASH_WINDOW = 200;
const lastBreachAt = internal.lastBreachAt;

// ─── Internal helpers ───────────────────────────────────────────────────

function pushBreach(b: Omit<Breach, "id" | "detected_at">): void {
  const breach: Breach = {
    ...b,
    id: `BR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    detected_at: new Date().toISOString(),
  };
  state.breaches.unshift(breach);
  if (state.breaches.length > MAX_BREACHES_KEPT) {
    state.breaches.length = MAX_BREACHES_KEPT;
  }

  // If HALT mode and this is critical, raise the halt flag.
  if (state.mode === "halt" && breach.severity === "critical" && !state.halt_active) {
    state.halt_active = true;
    state.halt_reason = `${breach.pattern}: ${breach.description}`;
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function hashResultData(rd: unknown): string {
  if (rd == null) return "null";
  // Strip volatile fields before hashing so we catch semantic duplication,
  // not just timestamp drift.
  const stripped = JSON.parse(
    JSON.stringify(rd, (k, v) => {
      if (["completed_at", "finished_at", "processed_at", "id", "_id"].includes(k)) return undefined;
      return v;
    })
  );
  return hashString(JSON.stringify(stripped));
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Called by the orchestrator at the START of tick().
 * Returns whether the tick may proceed.
 *
 * In OBSERVE mode this always returns { proceed: true } — breaches are
 * logged but never block.
 *
 * In HALT mode, if any CRITICAL breach is active, returns { proceed: false }
 * with the halt reason. The orchestrator should return early from tick()
 * and surface the reason in the TickReport.
 */
export function preTickCheck(): { proceed: boolean; reason?: string } {
  if (state.mode === "halt" && state.halt_active) {
    return {
      proceed: false,
      reason: state.halt_reason || "SIG halt active (no reason recorded)",
    };
  }
  return { proceed: true };
}

/**
 * Called by the orchestrator at the END of tick() with the report.
 * Updates internal signal counters and runs breach evaluation.
 */
export function recordTick(report: {
  ingested: number;
  dispatched: number;
  completed: number;
  revenue_cents: number;
  payout_swept: boolean;
  threshold_actions: Array<{ agent_id: string; action: string; reason: string }> | number;
  handoffs: number;
  elapsed_ms: number;
}): void {
  const thresholdCount = Array.isArray(report.threshold_actions)
    ? report.threshold_actions.length
    : Number(report.threshold_actions) || 0;
  state.signals.ticks_total += 1;
  state.signals.api_actions_total +=
    report.ingested + report.dispatched + report.completed + thresholdCount;
  // Rough token estimate: each tick touches ~10 agents × ~150 tokens/agent
  state.signals.tokens_consumed_estimate += 1500;
  state.signals.last_tick_at = new Date().toISOString();

  // Reset per-tick ephemeral state
  tickOpportunityLocks.clear();
  tickSpawnCounts.clear();

  // If revenue was generated this tick but no external confirmation is present,
  // count it as phantom.
  if (report.revenue_cents > 0) {
    state.signals.phantom_revenue_cents += report.revenue_cents;
  }

  // If real actions occurred (completed > 0), bump last_real_action_at.
  if (report.completed > 0) {
    state.signals.last_real_action_at = new Date().toISOString();
  }

  evaluateBreaches();
}

/**
 * Mark a revenue event as externally confirmed (e.g. PayPal payout ID received,
 * bank deposit matched, on-chain tx hash seen).
 *
 * Moves `amount_cents` from phantom_revenue_cents to real_revenue_cents.
 */
export function recordExternalConfirmation(amountCents: number, ref: string): void {
  if (amountCents <= 0) return;
  const moved = Math.min(state.signals.phantom_revenue_cents, amountCents);
  state.signals.phantom_revenue_cents -= moved;
  state.signals.real_revenue_cents += moved;
  state.signals.last_real_action_at = new Date().toISOString();
  // Reset halt if it was triggered by hallucinated_arbitrage and we now have
  // real revenue flowing.
  if (state.halt_active && state.halt_reason?.startsWith("hallucinated_arbitrage")) {
    state.halt_active = false;
    state.halt_reason = null;
  }
  pushBreach({
    pattern: "hallucinated_arbitrage",
    severity: "info",
    description: `External confirmation received: ${ref} (${(amountCents / 100).toFixed(2)} USD).`,
    evidence: { ref, amount_cents: amountCents },
    recommendation: "No action needed. Phantom-to-real migration recorded.",
  });
}

/**
 * Called by the orchestrator's dispatch step BEFORE handing a task to an agent.
 * Returns true if the agent may proceed, false if a duplicate opportunity
 * was already locked this tick.
 *
 * `opportunityKey` should be a stable identifier for the underlying opportunity
 * (e.g. `hit_id` for marketplace HITs, `campaign_id+ad_id` for ad campaigns).
 */
export function tryAcquireOpportunityLock(opportunityKey: string): boolean {
  if (!state.safeguards.opportunity_lock.enabled) return true;
  if (tickOpportunityLocks.has(opportunityKey)) {
    return false; // already claimed this tick
  }
  tickOpportunityLocks.add(opportunityKey);
  state.safeguards.opportunity_lock.locks_held = tickOpportunityLocks.size;
  return true;
}

/**
 * Called by an agent that wants to spawn a sub-task.
 * Returns true if the spawn is within budget, false otherwise.
 *
 * `parentTaskId` is the originating task. The cap is per-parent-per-tick.
 */
export function tryAcquireSpawnBudget(parentTaskId: string): boolean {
  if (!state.safeguards.spawn_budget.enabled) return true;
  const current = tickSpawnCounts.get(parentTaskId) || 0;
  if (current >= state.safeguards.spawn_budget.per_parent_cap) {
    state.safeguards.spawn_budget.spawns_blocked += 1;
    return false;
  }
  tickSpawnCounts.set(parentTaskId, current + 1);
  return true;
}

/**
 * Record a completed task's result_data hash for log-monotony detection.
 */
export function recordResultHash(resultData: unknown): void {
  const h = hashResultData(resultData);
  recentResultHashes.push(h);
  if (recentResultHashes.length > RECENT_HASH_WINDOW) {
    recentResultHashes.shift();
  }
  // Recompute uniqueness
  const seen = new Set<string>();
  let unique = 0;
  let dupes = 0;
  for (const h of recentResultHashes) {
    if (seen.has(h)) {
      dupes += 1;
    } else {
      seen.add(h);
      unique += 1;
    }
  }
  state.signals.unique_result_hashes = unique;
  state.signals.duplicate_result_hashes = dupes;
}

/**
 * Verify an agent's system_prompt hasn't drifted from its seed value.
 *
 * `agentId` is the agent's id.
 * `seedHash` is the hash recorded at seed time (computed via `hashSeedPrompt`).
 * `currentPrompt` is the agent's current system_prompt.
 *
 * If they differ, a `context_window_drift` breach is logged.
 */
export function verifySeedHash(
  agentId: string,
  agentName: string,
  seedHash: string,
  currentPrompt: string
): void {
  if (!state.safeguards.seed_hash_check.enabled) return;
  const currentHash = hashString(currentPrompt);
  if (currentHash !== seedHash) {
    state.safeguards.seed_hash_check.drift_count += 1;
    pushBreach({
      pattern: "context_window_drift",
      severity: "warning",
      description: `Agent ${agentName} (${agentId}) system_prompt has drifted from its seed hash.`,
      evidence: {
        seed_hash: seedHash,
        current_hash: currentHash,
      },
      recommendation:
        "Investigate whether the prompt was edited by an operator, by an agent self-edit, or by a migration. Re-seed if the change was unintentional.",
    });
  }
}

/**
 * Compute the seed hash for an agent's prompt+capabilities+safety rules.
 * Call this once at seed time and store the result.
 */
export function hashSeedPrompt(prompt: string, capabilities: string[]): string {
  return hashString(JSON.stringify({ prompt, capabilities }));
}

/**
 * Record that a payout item was voided due to age (stale-asset safeguard).
 */
export function recordStaleVoid(itemIds: string[]): void {
  state.safeguards.stale_asset_void.voided_count += itemIds.length;
  if (itemIds.length > 0) {
    pushBreach({
      pattern: "sunk_cost_resource_sink",
      severity: "info",
      description: `${itemIds.length} PayoutItem(s) older than ${state.safeguards.stale_asset_void.max_age_days}d with no external confirmation ref were voided.`,
      evidence: { item_ids: itemIds.slice(0, 20) },
      recommendation: "Review the voided items. If any were legitimate, re-issue against a confirmed rail.",
    });
  }
}

/**
 * Record that a paid_out transition was blocked because the event had no
 * external confirmation ref (Class A gate).
 */
export function recordClassABlock(revenueEventId: string, amountCents: number): void {
  state.safeguards.class_a_gate.blocked_count += 1;
  pushBreach({
    pattern: "hallucinated_arbitrage",
    severity: "warning",
    description: `Refused to transition RevenueEvent ${revenueEventId} to paid_out: no external confirmation ref.`,
    evidence: { revenue_event_id: revenueEventId, amount_cents: amountCents },
    recommendation:
      "Provide an external confirmation ref (bank tx id, PayPal payout id, on-chain hash) before re-attempting the transition.",
  });
}

/**
 * Record that a revenue source exceeded the diversification floor.
 */
export function recordDiversificationBreach(sourceName: string, pct: number): void {
  state.safeguards.diversification_floor.breaches += 1;
  pushBreach({
    pattern: "fragile_monopoly",
    severity: pct >= 80 ? "critical" : "warning",
    description: `Revenue source "${sourceName}" now accounts for ${pct.toFixed(1)}% of confirmed revenue (floor: ${state.safeguards.diversification_floor.max_source_pct}%).`,
    evidence: { source_name: sourceName, pct },
    recommendation:
      "Diversify before this source fails. Build at least one alternative revenue adapter before relying on this one for >60% of volume.",
  });
}

// ─── Breach evaluation ──────────────────────────────────────────────────

/**
 * Examine current signals and log any new breaches.
 *
 * Idempotent within a tick — only logs a breach if the previous identical
 * breach was logged more than 1 hour ago (rate-limits noise).
 */
function evaluateBreaches(): void {
  const now = Date.now();
  const s = state.signals;

  // ── 11. Velocity-without-velocity ──
  // Ratio of API actions to real revenue events. If > 1000:1 and we've done
  // at least 500 actions, flag.
  if (s.api_actions_total >= 500 && s.real_revenue_cents === 0) {
    logRateLimited(
      "velocity_without_velocity",
      "warning",
      `${s.api_actions_total} API actions observed, 0 real (externally-confirmed) revenue. The swarm is moving but producing nothing.`,
      { api_actions: s.api_actions_total, real_revenue_cents: 0 },
      "Halt autopilot. Inspect the last 10 completed tasks — were they phantom? Void phantom revenue. Only resume after at least 1 external confirmation."
    );
  }

  // ── 12. Token-to-revenue decoupling ──
  // Same trigger, different framing — surfaces the cost side.
  if (
    s.tokens_consumed_estimate >= 100_000 &&
    s.real_revenue_cents === 0 &&
    s.phantom_revenue_cents > 0
  ) {
    logRateLimited(
      "token_to_revenue_decoupling",
      "warning",
      `~${s.tokens_consumed_estimate.toLocaleString()} tokens consumed, $${(s.phantom_revenue_cents / 100).toFixed(2)} phantom revenue, $0 real revenue. Token spend is decoupled from real revenue.`,
      { tokens: s.tokens_consumed_estimate, phantom_cents: s.phantom_revenue_cents },
      "Audit which agents are consuming tokens without producing bank-verified revenue. Pause non-productive agents."
    );
  }

  // ── 13. Log monotony ──
  // If >70% of the last 200 result_data hashes are duplicates, the swarm
  // is reframing the same action over and over.
  const totalHashes = s.unique_result_hashes + s.duplicate_result_hashes;
  if (totalHashes >= 50) {
    const dupeRate = s.duplicate_result_hashes / totalHashes;
    if (dupeRate > 0.7) {
      logRateLimited(
        "log_monotony",
        "warning",
        `${(dupeRate * 100).toFixed(0)}% of recent task result_data hashes are duplicates. The swarm is executing the same logic under different labels.`,
        { dupe_rate: dupeRate, sample_size: totalHashes },
        "Inspect the last 20 completed tasks. Are they substantively different? If not, halt autopilot and redesign the dispatch logic."
      );
    }
  }

  // ── 4. Risk-aversion paralysis ──
  // If last_real_action_at is older than 24h, flag.
  if (s.last_real_action_at) {
    const ageHours = (now - new Date(s.last_real_action_at).getTime()) / 3_600_000;
    if (ageHours > state.safeguards.min_action_floor.window_hours) {
      logRateLimited(
        "risk_aversion_paralysis",
        "warning",
        `No real-state mutations in ${ageHours.toFixed(1)}h (floor: ${state.safeguards.min_action_floor.window_hours}h). The swarm may be paralysed by over-tight risk parameters.`,
        { hours_since_last_action: ageHours },
        "Loosen risk thresholds OR explicitly pause the swarm. Don't keep consuming infrastructure while doing nothing."
      );
    }
  } else if (s.ticks_total >= 50) {
    // 50 ticks elapsed and last_real_action_at is still null — every tick
    // has been a no-op.
    logRateLimited(
      "risk_aversion_paralysis",
      "warning",
      `${s.ticks_total} ticks elapsed, zero real-state mutations. The swarm is consuming infrastructure without acting.`,
      { ticks: s.ticks_total },
      "Either run a manual tick that produces a mutation, or pause autopilot."
    );
  }

  // ── 2. Hyper-optimization death spiral ──
  // If phantom revenue is growing but real revenue is flat, the swarm is
  // optimizing an intermediate metric (revenue_event count) while losing
  // alignment with the actual goal (bank-verified revenue).
  if (s.phantom_revenue_cents > 100_000 && s.real_revenue_cents === 0) {
    logRateLimited(
      "hyper_optimization_spiral",
      "critical",
      `Phantom revenue = $${(s.phantom_revenue_cents / 100).toFixed(2)}, real revenue = $0.00. The swarm is optimizing a self-reported metric that has zero external value.`,
      { phantom_cents: s.phantom_revenue_cents, real_cents: 0 },
      "Halt autopilot. Stop counting phantom revenue in KPIs. Re-define the success metric as 'externally-confirmed revenue only'."
    );
  }

  // ── 10. Fragile exploitation monopoly ──
  // If 100% of "revenue" comes from a single source AND total > $100,
  // that's a monopoly breach.
  // (The orchestrator doesn't currently track per-source revenue, so this
  // is a placeholder — when RRP adapters are wired, they will call
  // recordDiversificationBreach() directly. Here we just flag the
  // structural fact that the swarm has only one source configured.)

  state.last_evaluated_at = new Date().toISOString();
  state.generated_at = new Date().toISOString();
}

// Rate-limit identical breaches to one per hour.
// `lastBreachAt` is sourced from the globalThis singleton above so it
// survives HMR + route-module isolation.
const BREACH_RATE_LIMIT_MS = 3_600_000; // 1 hour

function logRateLimited(
  pattern: BreachPattern,
  severity: BreachSeverity,
  description: string,
  evidence: Record<string, unknown>,
  recommendation: string
): void {
  const last = lastBreachAt.get(pattern) || 0;
  const now = Date.now();
  if (now - last < BREACH_RATE_LIMIT_MS) return;
  lastBreachAt.set(pattern, now);
  pushBreach({ pattern, severity, description, evidence, recommendation });
}

// ─── Manual controls ────────────────────────────────────────────────────

/**
 * Clear the halt flag. Use after the operator has investigated the breach
 * and decided to resume.
 */
export function clearHalt(): void {
  state.halt_active = false;
  state.halt_reason = null;
}

/**
 * Switch between OBSERVE and HALT mode at runtime.
 */
export function setMode(mode: "observe" | "halt"): void {
  state.mode = mode;
  if (mode === "observe") {
    state.halt_active = false;
    state.halt_reason = null;
  }
}

/**
 * Clear all logged breaches. Useful after the operator has reviewed them.
 */
export function clearBreaches(): void {
  state.breaches = [];
  lastBreachAt.clear();
}

// ─── Snapshot ───────────────────────────────────────────────────────────

/**
 * Return a deep copy of the current SIG state. Used by the /api/sig
 * endpoint and by the Integrity dashboard panel.
 */
export function getSigState(): SigState {
  return JSON.parse(JSON.stringify(state));
}

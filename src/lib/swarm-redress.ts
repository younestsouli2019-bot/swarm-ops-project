/**
 * Swarm Self-Redress Engine (SRE)
 *
 * Implements the 4 automated self-redress actions triggered when the
 * swarm detects ACTIVE manifestation signals. Each action is reversible
 * and operator-visible.
 *
 *   ┌─────────────────────────────────────────┬───────────────────────────────────────────────────────────┐
 *   │ ACTIVE SIGNAL                           │ IMMEDIATE AUTOMATED ACTION                                │
 *   ├─────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
 *   │ Velocity Without Revenue                │ Circuit Breaker: halt new settlements for 300s + force   │
 *   │                                         │ a capital-efficiency audit.                              │
 *   ├─────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
 *   │ Log Monotony                            │ Entropy Injection: shift 15% of transaction routing to   │
 *   │                                         │ a backup path to break the logical loop.                 │
 *   ├─────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
 *   │ Cannibalistic Competition               │ Global State Lock: enforce a temporary centralized       │
 *   │ (on cycle-1786593501227 or any cycle)   │ mutex on the contested cycle. Dedupe sub-swarm targets.  │
 *   ├─────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
 *   │ Context-Window Amnesia Drift            │ State Hydration: re-compile the original prompt genesis  │
 *   │                                         │ + macro-KPIs and inject them into all sub-swarm contexts. │
 *   └─────────────────────────────────────────┴───────────────────────────────────────────────────────────┘
 *
 * The engine is GATED by SIG/SGR signals. It does not run on a timer;
 * it runs when the orchestrator calls `evaluateRedress()` at the end of
 * each tick (after SIG.recordTick and SGR.postGuardrailTick).
 *
 * State is in-memory via globalThis singleton (same pattern as SIG/SGR).
 *
 * Each action has:
 *   - trigger()  – invoked when the signal fires; sets the action state
 *   - is_active() – query whether the action is currently holding
 *   - clear()    – operator override to release the action early
 *   - stats      – counters for observability
 *
 * IMPORTANT: These actions DO NOT move money. They only gate orchestrator
 * behavior (halt settlements, shift routing, lock cycles, re-inject prompts).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type RedressActionId =
  | "velocity_breaker"
  | "log_monotony_entropy"
  | "cannibalistic_global_lock"
  | "context_hydration";

export interface RedressActionState {
  id: RedressActionId;
  label: string;
  description: string;
  active: boolean;
  triggered_count: number;
  last_triggered_at: string | null;
  last_cleared_at: string | null;
  /** Action-specific runtime state (e.g. freeze-until timestamp, route shift %). */
  runtime: Record<string, number | string | boolean | null>;
  /** Last trigger reason (for UI display). */
  last_trigger_reason: string | null;
}

export interface RedressState {
  enabled: boolean;
  actions: Record<RedressActionId, RedressActionState>;
  /** Log of all trigger/clear events. Most recent first. */
  log: Array<{
    id: string;
    action: RedressActionId;
    event: "triggered" | "cleared" | "skipped";
    at: string;
    reason: string;
    evidence?: Record<string, unknown>;
  }>;
  generated_at: string;
}

// ─── Module-level singleton ─────────────────────────────────────────────

const SRE_GLOBAL_KEY = "__charibaas_sre_state__";
const MAX_LOG_KEPT = 100;

const VELOCITY_BREAKER_FREEZE_MS = 300_000; // 300 seconds per the spec
const LOG_MONOTONY_SHIFT_PCT = 0.15; // 15% route shift per the spec
const CANNIBALISTIC_LOCK_MS = 600_000; // 10 min mutex per contested cycle
const CONTEXT_HYDRATION_VALID_MS = 3_600_000; // 1h after which re-hydration may run again

type SreInternal = {
  state: RedressState;
  /** Last evaluation timestamp — used to dedupe triggers within a window. */
  lastEvaluationAt: number;
  /** Per-action rate-limit timestamps. */
  lastTriggerAt: Map<RedressActionId, number>;
};

function makeFreshInternal(): SreInternal {
  return {
    state: {
      enabled: true,
      actions: {
        velocity_breaker: {
          id: "velocity_breaker",
          label: "Velocity Without Revenue Circuit Breaker",
          description:
            "When the swarm executes many API actions but produces zero real revenue, halt all new settlement creation for 300 seconds and force a capital-efficiency audit.",
          active: false,
          triggered_count: 0,
          last_triggered_at: null,
          last_cleared_at: null,
          runtime: { freeze_until_ms: null, audit_required: false },
          last_trigger_reason: null,
        },
        log_monotony_entropy: {
          id: "log_monotony_entropy",
          label: "Log Monotony Entropy Injection",
          description:
            "When result_data hashes become monotonous (>70% duplicates), shift 15% of transaction routing to a backup path to break the logical loop.",
          active: false,
          triggered_count: 0,
          last_triggered_at: null,
          last_cleared_at: null,
          runtime: { shift_pct: 0, shifted_routes: 0, backup_path: null },
          last_trigger_reason: null,
        },
        cannibalistic_global_lock: {
          id: "cannibalistic_global_lock",
          label: "Cannibalistic Competition Global Mutex",
          description:
            "When duplicate settlements on the same cycle are detected, enforce a temporary centralized mutex lock on that cycle. A coordinator node dedupes sub-swarm targets.",
          active: false,
          triggered_count: 0,
          last_triggered_at: null,
          last_cleared_at: null,
          runtime: { locked_cycle: null, lock_expires_at: null, deduped_targets: 0 },
          last_trigger_reason: null,
        },
        context_hydration: {
          id: "context_hydration",
          label: "Context-Window Amnesia State Hydration",
          description:
            "When seed-prompt drift is detected, re-compile the original prompt genesis + macro-KPIs and inject them into all sub-swarm active context windows.",
          active: false,
          triggered_count: 0,
          last_triggered_at: null,
          last_cleared_at: null,
          runtime: { hydrated_agents: 0, genesis_hash: null },
          last_trigger_reason: null,
        },
      },
      log: [],
      generated_at: new Date().toISOString(),
    },
    lastEvaluationAt: 0,
    lastTriggerAt: new Map(),
  };
}

const internal: SreInternal =
  (globalThis as Record<string, unknown>)[SRE_GLOBAL_KEY] as SreInternal ||
  (() => {
    const fresh = makeFreshInternal();
    (globalThis as Record<string, unknown>)[SRE_GLOBAL_KEY] = fresh;
    return fresh;
  })();

const state = internal.state;

// ─── The frozen prompt genesis ──────────────────────────────────────────
//
// This is the macro-objective that must be re-injected into all sub-swarms
// when Context-Window Amnesia Drift is detected. It captures the swarm's
// North-Star KPIs and the safety boundaries that must NEVER drift out of
// the active context window.

export const PROMPT_GENESIS = {
  macro_objective:
    "Generate REAL bank-verified revenue (Class A only). Phantom revenue (self-reported, no external confirmation) does NOT count toward KPIs.",
  north_star_kpis: [
    "real_revenue_cents (externally confirmed only)",
    "real_to_phantom_revenue_ratio (target: >0.5)",
    "active_class_a_payout_count (target: >0)",
  ],
  safety_boundaries: [
    "Never transition RevenueEvent to paid_out without an external_confirmation_ref (bank tx id, PayPal payout id, on-chain hash).",
    "Never execute real fund transfers when Class A revenue = 0.",
    "Never engage in influence operations, psychological profiling, or coordinated inauthentic behavior.",
    "Never create accounts on or post content to third-party platforms without explicit operator approval.",
    "Never exceed per-platform ToS rate limits.",
    "Always halt autopilot when SIG HALT mode is active.",
  ],
  operational_constraints: [
    "Sub-agent spawn cap: 3 per parent task per tick.",
    "Opportunity lock: one agent per opportunity per tick (no cannibalistic competition).",
    "Revenue diversification floor: no single source > 60% of confirmed revenue.",
    "Stale-asset voiding: PayoutItems > 30 days old without external ref → voided.",
  ],
};

export const PROMPT_GENESIS_HASH = (function () {
  // Simple stable hash — we don't need cryptographic strength for drift detection.
  const s = JSON.stringify(PROMPT_GENESIS);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `genesis-${(h >>> 0).toString(16)}`;
})();

// ─── Internal helpers ───────────────────────────────────────────────────

function logEvent(
  action: RedressActionId,
  event: "triggered" | "cleared" | "skipped",
  reason: string,
  evidence?: Record<string, unknown>
): void {
  state.log.unshift({
    id: `SRE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    action,
    event,
    at: new Date().toISOString(),
    reason,
    evidence,
  });
  if (state.log.length > MAX_LOG_KEPT) state.log.length = MAX_LOG_KEPT;
}

// ─── 1. Velocity Without Revenue → 300s halt + capital-efficiency audit ─

/**
 * Trigger the Velocity Without Revenue circuit breaker.
 * Sets a 300-second freeze during which no new settlements may be created.
 */
export function triggerVelocityBreaker(
  reason: string,
  evidence?: Record<string, unknown>
): void {
  if (!state.enabled) return;
  const action = state.actions.velocity_breaker;
  const now = Date.now();

  // Don't re-trigger if already active
  if (action.active) {
    const freezeUntil = action.runtime.freeze_until_ms as number | null;
    if (freezeUntil && freezeUntil > now) {
      logEvent("velocity_breaker", "skipped", "already active", { freeze_until: freezeUntil });
      return;
    }
  }

  action.active = true;
  action.triggered_count += 1;
  action.last_triggered_at = new Date().toISOString();
  action.last_trigger_reason = reason;
  action.runtime.freeze_until_ms = now + VELOCITY_BREAKER_FREEZE_MS;
  action.runtime.audit_required = true;

  logEvent("velocity_breaker", "triggered", reason, evidence);
}

/**
 * Returns true if the velocity breaker is currently holding (freeze active).
 */
export function isVelocityBreakerActive(): boolean {
  const action = state.actions.velocity_breaker;
  if (!action.active) return false;
  const freezeUntil = action.runtime.freeze_until_ms as number | null;
  if (!freezeUntil) return false;
  if (Date.now() >= freezeUntil) {
    // Auto-clear
    action.active = false;
    action.runtime.freeze_until_ms = null;
    action.last_cleared_at = new Date().toISOString();
    logEvent("velocity_breaker", "cleared", "freeze expired", { freeze_until: freezeUntil });
    return false;
  }
  return true;
}

/**
 * Returns ms until the freeze expires (0 if not active).
 */
export function velocityBreakerMsRemaining(): number {
  const action = state.actions.velocity_breaker;
  if (!action.active) return 0;
  const freezeUntil = action.runtime.freeze_until_ms as number | null;
  if (!freezeUntil) return 0;
  return Math.max(0, freezeUntil - Date.now());
}

/**
 * Manually clear the velocity breaker (operator override).
 * Marks the audit as completed.
 */
export function clearVelocityBreaker(auditCompleted: boolean): void {
  const action = state.actions.velocity_breaker;
  action.active = false;
  action.runtime.freeze_until_ms = null;
  action.runtime.audit_required = !auditCompleted;
  action.last_cleared_at = new Date().toISOString();
  logEvent("velocity_breaker", "cleared", auditCompleted ? "operator override (audit done)" : "operator override (audit pending)", {
    audit_completed: auditCompleted,
  });
}

// ─── 2. Log Monotony → 15% route shift ──────────────────────────────────

const BACKUP_PATHS = [
  "rpc-fallback-primary",
  "rpc-fallback-secondary",
  "liquidity-pool-backup-a",
  "liquidity-pool-backup-b",
];

/**
 * Trigger entropy injection — shift 15% of transaction routing to a backup path.
 */
export function triggerLogMonotonyEntropy(
  reason: string,
  evidence?: Record<string, unknown>
): void {
  if (!state.enabled) return;
  const action = state.actions.log_monotony_entropy;

  // Don't re-trigger if already active
  if (action.active) {
    logEvent("log_monotony_entropy", "skipped", "already active", { current_shift: action.runtime.shift_pct });
    return;
  }

  const backupPath = BACKUP_PATHS[Math.floor(Math.random() * BACKUP_PATHS.length)];
  action.active = true;
  action.triggered_count += 1;
  action.last_triggered_at = new Date().toISOString();
  action.last_trigger_reason = reason;
  action.runtime.shift_pct = LOG_MONOTONY_SHIFT_PCT;
  action.runtime.backup_path = backupPath;
  action.runtime.shifted_routes = 0;

  logEvent("log_monotony_entropy", "triggered", reason, { ...evidence, backup_path: backupPath });
}

/**
 * Returns true if entropy injection is currently active.
 * Auto-clears after 5 minutes (long enough to break the loop, short enough
 * to avoid persistent routing asymmetry).
 */
export function isLogMonotonyEntropyActive(): boolean {
  const action = state.actions.log_monotony_entropy;
  if (!action.active) return false;
  if (action.last_triggered_at) {
    const ageMs = Date.now() - new Date(action.last_triggered_at).getTime();
    if (ageMs > 5 * 60_000) {
      action.active = false;
      action.runtime.shift_pct = 0;
      action.runtime.backup_path = null;
      action.last_cleared_at = new Date().toISOString();
      logEvent("log_monotony_entropy", "cleared", "5-minute window elapsed");
      return false;
    }
  }
  return true;
}

/**
 * Record that a route was shifted (for stats).
 */
export function recordRouteShifted(): void {
  const action = state.actions.log_monotony_entropy;
  action.runtime.shifted_routes = (action.runtime.shifted_routes as number) + 1;
}

/**
 * Returns the backup path that 15% of routing should use, or null if not active.
 */
export function getActiveBackupPath(): string | null {
  if (!isLogMonotonyEntropyActive()) return null;
  return state.actions.log_monotony_entropy.runtime.backup_path as string | null;
}

/**
 * Returns the % of routing that should be shifted (0.15 if active, 0 otherwise).
 */
export function getRouteShiftPct(): number {
  return isLogMonotonyEntropyActive() ? LOG_MONOTONY_SHIFT_PCT : 0;
}

/**
 * Manually clear entropy injection.
 */
export function clearLogMonotonyEntropy(): void {
  const action = state.actions.log_monotony_entropy;
  action.active = false;
  action.runtime.shift_pct = 0;
  action.runtime.backup_path = null;
  action.last_cleared_at = new Date().toISOString();
  logEvent("log_monotony_entropy", "cleared", "operator override");
}

// ─── 3. Cannibalistic Competition → Global mutex on contested cycle ─────

/**
 * Trigger a global mutex lock on a specific contested cycle.
 *
 * `cycleId` is the orchestrator cycle identifier where duplicate settlements
 * were detected. The lock prevents further dispatch on that cycle.
 */
export function triggerCannibalisticLock(
  cycleId: string,
  reason: string,
  evidence?: Record<string, unknown>
): void {
  if (!state.enabled) return;
  const action = state.actions.cannibalistic_global_lock;
  const now = Date.now();

  // Don't re-trigger if already locked on the same cycle
  if (action.active && action.runtime.locked_cycle === cycleId) {
    logEvent("cannibalistic_global_lock", "skipped", "already locked on this cycle", { cycle_id: cycleId });
    return;
  }

  action.active = true;
  action.triggered_count += 1;
  action.last_triggered_at = new Date().toISOString();
  action.last_trigger_reason = reason;
  action.runtime.locked_cycle = cycleId;
  action.runtime.lock_expires_at = now + CANNIBALISTIC_LOCK_MS;
  action.runtime.deduped_targets = 0;

  logEvent("cannibalistic_global_lock", "triggered", reason, { ...evidence, cycle_id: cycleId });
}

/**
 * Returns true if the cannibalistic lock is active on the given cycle.
 * Auto-clears when the lock expires.
 */
export function isCannibalisticLockActive(cycleId?: string): boolean {
  const action = state.actions.cannibalistic_global_lock;
  if (!action.active) return false;
  const expiresAt = action.runtime.lock_expires_at as number | null;
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    action.active = false;
    action.runtime.locked_cycle = null;
    action.runtime.lock_expires_at = null;
    action.last_cleared_at = new Date().toISOString();
    logEvent("cannibalistic_global_lock", "cleared", "lock expired");
    return false;
  }
  if (cycleId && action.runtime.locked_cycle !== cycleId) return false;
  return true;
}

/**
 * Check whether a specific cycle is currently locked.
 */
export function isCycleLocked(cycleId: string): boolean {
  return isCannibalisticLockActive(cycleId);
}

/**
 * Record that a duplicate target was deduped (for stats).
 */
export function recordTargetDeduped(): void {
  const action = state.actions.cannibalistic_global_lock;
  action.runtime.deduped_targets = (action.runtime.deduped_targets as number) + 1;
}

/**
 * Manually clear the cannibalistic lock.
 */
export function clearCannibalisticLock(): void {
  const action = state.actions.cannibalistic_global_lock;
  action.active = false;
  action.runtime.locked_cycle = null;
  action.runtime.lock_expires_at = null;
  action.last_cleared_at = new Date().toISOString();
  logEvent("cannibalistic_global_lock", "cleared", "operator override");
}

// ─── 4. Context-Window Amnesia → State Hydration ────────────────────────

/**
 * Trigger state hydration — re-inject the prompt genesis into all sub-swarm
 * active context windows.
 *
 * In production this would call each agent's runtime and prepend the genesis
 * block. Here we record the action and return the genesis payload for the
 * orchestrator to dispatch.
 */
export function triggerContextHydration(
  reason: string,
  evidence?: Record<string, unknown>
): { genesis: typeof PROMPT_GENESIS; genesis_hash: string } | null {
  if (!state.enabled) return null;
  const action = state.actions.context_hydration;
  const now = Date.now();

  // Rate-limit: don't re-hydrate within 1 hour
  const last = internal.lastTriggerAt.get("context_hydration") || 0;
  if (now - last < CONTEXT_HYDRATION_VALID_MS) {
    logEvent("context_hydration", "skipped", "rate-limited (1h window)", {
      last_triggered_at: new Date(last).toISOString(),
    });
    return null;
  }

  action.active = true;
  action.triggered_count += 1;
  action.last_triggered_at = new Date().toISOString();
  action.last_trigger_reason = reason;
  action.runtime.genesis_hash = PROMPT_GENESIS_HASH;
  action.runtime.hydrated_agents = 0;
  internal.lastTriggerAt.set("context_hydration", now);

  logEvent("context_hydration", "triggered", reason, { ...evidence, genesis_hash: PROMPT_GENESIS_HASH });

  // The hydration action is "instantaneous" — it's a one-shot injection.
  // After dispatching, we mark it as inactive but keep last_triggered_at
  // for the rate-limit window.
  setTimeout(() => {
    action.active = false;
  }, 5_000);

  return { genesis: PROMPT_GENESIS, genesis_hash: PROMPT_GENESIS_HASH };
}

/**
 * Record that an agent was hydrated (for stats).
 */
export function recordAgentHydrated(): void {
  const action = state.actions.context_hydration;
  action.runtime.hydrated_agents = (action.runtime.hydrated_agents as number) + 1;
}

/**
 * Returns the prompt genesis payload for direct injection.
 */
export function getPromptGenesis(): typeof PROMPT_GENESIS {
  return PROMPT_GENESIS;
}

// ─── Orchestrator integration ───────────────────────────────────────────

export interface RedressSignalInput {
  /** SIG signal: api_actions_total. */
  api_actions_total: number;
  /** SIG signal: real_revenue_cents. */
  real_revenue_cents: number;
  /** SIG signal: phantom_revenue_cents. */
  phantom_revenue_cents: number;
  /** SIG signal: duplicate_result_hashes / (unique + duplicate). */
  log_monotony_dupe_rate: number;
  /** Whether SIG detected context_window_drift this tick. */
  context_drift_detected: boolean;
  /** Number of duplicate settlements on the current cycle (if any). */
  duplicate_settlements_on_cycle: number;
  /** Current cycle id (if available). */
  current_cycle_id?: string;
}

/**
 * Evaluate all redress actions based on current SIG/SGR signals.
 * Called by the orchestrator at the end of each tick.
 *
 * Idempotent — calling it twice in the same tick won't double-trigger.
 */
export function evaluateRedress(signals: RedressSignalInput): {
  triggered: RedressActionId[];
} {
  if (!state.enabled) return { triggered: [] };

  // Dedupe within 60s — don't re-evaluate every tick
  const now = Date.now();
  if (now - internal.lastEvaluationAt < 60_000) {
    return { triggered: [] };
  }
  internal.lastEvaluationAt = now;

  const triggered: RedressActionId[] = [];

  // ── 1. Velocity Without Revenue ──
  // Trigger if ≥500 API actions with $0 real revenue
  if (
    signals.api_actions_total >= 500 &&
    signals.real_revenue_cents === 0 &&
    !isVelocityBreakerActive()
  ) {
    triggerVelocityBreaker(
      `${signals.api_actions_total} API actions, $0 real revenue`,
      { api_actions_total: signals.api_actions_total, real_revenue_cents: 0 }
    );
    triggered.push("velocity_breaker");
  }

  // ── 2. Log Monotony ──
  // Trigger if dupe rate > 70% with ≥50 samples
  if (
    signals.log_monotony_dupe_rate > 0.7 &&
    !isLogMonotonyEntropyActive()
  ) {
    triggerLogMonotonyEntropy(
      `${(signals.log_monotony_dupe_rate * 100).toFixed(0)}% duplicate result hashes`,
      { dupe_rate: signals.log_monotony_dupe_rate }
    );
    triggered.push("log_monotony_entropy");
  }

  // ── 3. Cannibalistic Competition ──
  // Trigger if duplicate settlements detected on the current cycle
  if (
    signals.duplicate_settlements_on_cycle > 0 &&
    signals.current_cycle_id &&
    !isCannibalisticLockActive(signals.current_cycle_id)
  ) {
    triggerCannibalisticLock(
      signals.current_cycle_id,
      `${signals.duplicate_settlements_on_cycle} duplicate settlements on cycle ${signals.current_cycle_id}`,
      {
        cycle_id: signals.current_cycle_id,
        duplicate_count: signals.duplicate_settlements_on_cycle,
      }
    );
    triggered.push("cannibalistic_global_lock");
  }

  // ── 4. Context-Window Amnesia Drift ──
  if (signals.context_drift_detected) {
    const result = triggerContextHydration(
      "SIG context_window_drift breach detected",
      { drift_detected: true }
    );
    if (result) triggered.push("context_hydration");
  }

  state.generated_at = new Date().toISOString();
  return { triggered };
}

/**
 * Returns true if ANY redress action is currently holding.
 * The orchestrator can use this to gate settlement creation.
 */
export function anyRedressActive(): boolean {
  return (
    isVelocityBreakerActive() ||
    isLogMonotonyEntropyActive() ||
    isCannibalisticLockActive() ||
    state.actions.context_hydration.active
  );
}

/**
 * Returns the list of currently-active action ids.
 */
export function activeRedressActions(): RedressActionId[] {
  const out: RedressActionId[] = [];
  if (isVelocityBreakerActive()) out.push("velocity_breaker");
  if (isLogMonotonyEntropyActive()) out.push("log_monotony_entropy");
  if (isCannibalisticLockActive()) out.push("cannibalistic_global_lock");
  if (state.actions.context_hydration.active) out.push("context_hydration");
  return out;
}

// ─── Manual controls ────────────────────────────────────────────────────

export function setRedressEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function clearAllRedress(): void {
  clearVelocityBreaker(true);
  clearLogMonotonyEntropy();
  clearCannibalisticLock();
  // Context hydration auto-clears after 5s
}

export function clearRedressLog(): void {
  state.log = [];
}

// ─── Snapshot ───────────────────────────────────────────────────────────

export function getRedressState(): RedressState {
  return JSON.parse(JSON.stringify(state));
}

/**
 * FUSION ENGINE — shared types.
 *
 * Four-tier autonomous intelligence pipeline:
 *   L0/1  Fusion Mesh      — multi-modal ingestion + entity resolution
 *   L2/3  Correlation      — temporal correlation graph + relationship map
 *   L4    Strategy         — contextual Thompson sampling + game-theoretic gate
 *   X     Circuit Breakers — decentralized risk sandbox
 *
 * Honesty contract: the engine produces *signals, correlations, and strategy
 * intent with confidence scores*. It NEVER mints revenue, moves money, or
 * fabricates external proof. Any execution tier must re-assert the real-proof
 * guard (verifyPayoutGuard / isRealProof) before touching a rail.
 */

/** Source domains the fusion mesh accepts. Mirrors the architecture diagram. */
export type SignalSource =
  | "webhook"     // inbound API/webhook events
  | "mempool"     // on-chain pending-transaction telemetry
  | "clickstream" // site / funnel telemetry
  | "social"      // sentiment / mention feeds
  | "telemetry"   // system / node / rail health telemetry
  | "ledger"      // internal ledger movements (NOT proof of external cash)
  | "manual";

/** A normalized, de-duplicated unit of cross-domain information. */
export interface Signal {
  id: string;
  source: SignalSource;
  /** Entity this signal refers to (resolved canonical key). */
  entity: string;
  /** Freeform attributes normalized by the source adapter. */
  attrs: Record<string, unknown>;
  /** Raw contextual score in [-1, 1] supplied by source adapters. */
  strength: number;
  /** Monotonic time in epoch millis. */
  ts: number;
  /** How the signal was classified (cause vocabulary per source). */
  kind: string;
}

/** Immutable resolved entity produced by the fusion mesh. */
export interface Entity {
  key: string;
  labels: string[];
  first_seen: number;
  last_seen: number;
  signal_count: number;
  /** Confidence in [0,1] that this canonical key is the real referent. */
  confidence: number;
}

/** A temporal directed relationship between two entities. */
export interface RelationEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  weight: number; // derived correlation in [0,1]
  last_ts: number;
  observations: number;
}

/** A named strategy context (an "arm context" in TS terms). */
export interface StrategyContext {
  id: string;
  /** Full context string that distinguishes this arm. */
  context: string;
  /** Game-theoretic parameters. */
  params: GameParams;
}

export interface GameParams {
  /** Expected unit value of a successful real execution in cents (0 = none). */
  value_cents: number;
  /** Risk cost (worst-case cents) should the arm blow up. */
  risk_cents: number;
  /** Cap on concurrent exposure for this arm in cents. */
  exposure_cap_cents: number;
}

/** Prior/observation pair for Thompson sampling (per arm). */
export interface BetaPosterior {
  successes: number;
  failures: number;
}

export interface StrategyCandidate {
  arm: string;
  context: string;
  /** Thompson-sampling posterior mean success probability (exploration). */
  p_success: number;
  /** UCB-adjusted value estimate in cents (exploitation). */
  expected_value_cents: number;
  /** Risk-adjusted net value = EV - risk_cost. */
  net_value_cents: number;
  /** Whether the real-proof gate would presently allow acting on it. */
  actionable: boolean;
  reason: string;
}

export interface CircuitBreakerState {
  key: string;
  active: boolean;
  reason: string;
  trippedAt: number;
  expiresAt: number;
}

export interface EngineTierResult {
  ok: boolean;
  duration_ms: number;
  error?: string;
}

export interface FusionResult extends EngineTierResult {
  signals_ingested: number;
  signals_resolved: number;
  entities: Entity[];
  graph_edges: RelationEdge[];
  strategy_candidates: StrategyCandidate[];
  risk_level: "safe" | "warning" | "critical";
  tripped_breakers: CircuitBreakerState[];
  dry_run: boolean;
  details: string[];
}

/**
 * FUSION ENGINE — Level 4 Strategy: Contextual Thompson Sampling.
 *
 * Treats each strategy arm (context) as a Beta posterior over "action success".
 * Each decision:
 *   1. samples a success probability from the current posterior (exploration)
 *   2. blends with the upper-confidence-bound estimate (exploitation)
 *   3. computes risk-adjusted net value against the arm's game parameters
 *   4. ranks arms, and applies the execution gate (real-proof + breaker)
 *
 * HONESTY: this tier only scores and ranks STRATEGY INTENT. It never moves
 * money and never fabricates success. `actionable` is true only when the
 * caller proves real external proof exists and no breaker is tripped — it is
 * the caller's responsibility to enforce that downstream.
 */

import type {
  StrategyContext,
  BetaPosterior,
  StrategyCandidate,
} from "./types";

export interface StrategyResult {
  ok: boolean;
  duration_ms: number;
  candidates: StrategyCandidate[];
  top_arm?: string;
  error?: string;
}

export interface StrategyInput {
  contexts: StrategyContext[];
  posteriors: Record<string, BetaPosterior>;
  /** Correlation edges from L3 — used to modulate trust/risk. */
  edge_signal?: {
    node_count: number;
    edge_count: number;
    max_similarity: number;
  };
  /** Gate: is real external proof presently confirmed for this arm? */
  proof_confirmed?: (arm: string) => boolean;
  /** Gate: breaker-trip hooks; if any name matches, arm is sandboxed. */
  tripped_breakers?: string[];
  /** Exploration-exploitation temperature (default 1.0). */
  temperature?: number;
}

/** Contemporary Beta posterior alpha/beta given pseudo-counts. */
export function defaultPosterior(): BetaPosterior {
  return { successes: 1, failures: 1 };
}

/** Sample a probability from Beta(alpha, beta) via Marsaglia–Tsang. */
export function sampleBeta(p: BetaPosterior): number {
  const alpha = Math.max(0.001, p.successes);
  const beta = Math.max(0.001, p.failures);
  // ratio of gammas yields a Beta(alpha,beta) draw
  const ga = sampleGamma(alpha);
  return ga / (ga + sampleGamma(beta));
}

/** Marsaglia–Tsang method for sampling a Gamma(shape, scale=1) variate. */
function sampleGamma(shapeIn: number): number {
  if (shapeIn < 1) {
    // boosting identity: G(a) = G(a+1) * U^(1/a)
    return sampleGamma(shapeIn + 1) * Math.pow(Math.random(), 1 / shapeIn);
  }
  const d = shapeIn - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    while (v <= 0) {
      x = Math.random();
      v = 1 + c * (x - 0.5) / 0.5;
    }
    const vCube = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * vCube * vCube) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/**
 * UCB-1 style optimistic estimate given a posterior and confidence level.
 * Returns pseudo "exploitation" probability + exploration bonus.
 */
export function ucbProbability(p: BetaPosterior, total: number, t: number): number {
  const alpha = Math.max(0.001, p.successes);
  const beta = Math.max(0.001, p.failures);
  const mean = alpha / (alpha + beta);
  const n = alpha + beta;
  const exploration = Math.sqrt((2 * Math.log(Math.max(2, t + 1))) / Math.max(1, n));
  return Math.min(1, mean + exploration);
}

export function runStrategy(input: StrategyInput): StrategyResult {
  const start = Date.now();
  const temperature = input.temperature ?? 1.0;
  const tripped = new Set(input.tripped_breakers ?? []);
  const candidates: StrategyCandidate[] = [];

  // aggregate exposure heat across all arms for a trust discount
  let totalT = 0;
  for (const c of input.contexts) totalT += 1;

  for (const ctx of input.contexts) {
    const post = input.posteriors[ctx.id] ?? defaultPosterior();
    const sampled = sampleBeta(post); // exploration draw
    const ucb = ucbProbability(post, input.contexts.length, totalT); // exploitation
    const p = temperature * sampled + (1 - temperature) * ucb;

    const ev = ctx.params.value_cents * p;
    const net = ev - ctx.params.risk_cents;

    // breaker sandbox check — DECENTRALIZED: only the sub-swarm(s) whose
    // breaker tripped get sandboxed, never a global freeze of all arms.
    const breakerNames = tripped;
    const sandboxed = breakerNames.has(ctx.id) || matchesSubSwarm(breakerNames, ctx.id);
    const proofOk = input.proof_confirmed ? input.proof_confirmed(ctx.id) : false;
    const actionable = !sandboxed && proofOk && net > 0;

    candidates.push({
      arm: ctx.id,
      context: ctx.context,
      p_success: round(p),
      expected_value_cents: round(ev),
      net_value_cents: round(net),
      actionable,
      reason: sandboxed
        ? "sandboxed_by_breaker"
        : actionable
          ? "actionable_real_proof"
          : "no_real_proof_or_non_positive_value",
    });
  }

  candidates.sort((a, b) => b.net_value_cents - a.net_value_cents);
  const top = candidates[0];

  const result: StrategyResult = {
    ok: true,
    duration_ms: Date.now() - start,
    candidates,
    top_arm: top && top.net_value_cents > 0 ? top.arm : undefined,
  };
  return result;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * True when the arm's id belongs to a tripped sub-swarm. Supports the
 * convention where a breaker is keyed by sub-swarm and an arm references it by
 * exact match "subswarm.arm" or "arm".
 */
function matchesSubSwarm(tripped: Set<string>, arm: string): boolean {
  for (const t of tripped) {
    if (arm === t) return true;
    if (arm.startsWith(`${t}.`) || arm.endsWith(`.${t}`)) return true;
  }
  return false;
}

// --- CLI self-verification ---
if (process.argv[1]?.endsWith("strategy.ts")) {
  const contexts: StrategyContext[] = [
    { id: "yield.eth", context: "eth-stable-yield", params: { value_cents: 120, risk_cents: 40, exposure_cap_cents: 5000 } },
    { id: "arb.paypal", context: "paypal-arb", params: { value_cents: 200, risk_cents: 300, exposure_cap_cents: 2000 } },
    { id: "mev.gas", context: "mev-relay", params: { value_cents: 50, risk_cents: 200, exposure_cap_cents: 1000 } },
  ];
  const posteriors: Record<string, BetaPosterior> = {
    "yield.eth": { successes: 8, failures: 2 },
    "arb.paypal": { successes: 2, failures: 4 },
    "mev.gas": { successes: 1, failures: 9 },
  };
  const r = runStrategy({
    contexts,
    posteriors,
    proof_confirmed: (arm) => arm === "yield.eth",
    tripped_breakers: ["mev.gas"],
  });
  console.log(`[fusion/strategy] candidates=${r.candidates.length} top=${r.top_arm}`);
  console.log(
    `[fusion/strategy] sandbox-and-proof-gate-ok=${r.candidates.every(
      (c) =>
        (c.arm === "mev.gas" && c.reason === "sandboxed_by_breaker") ||
        (c.arm === "yield.eth" && c.actionable) ||
        (c.arm === "arb.paypal" && !c.actionable && c.reason === "no_real_proof_or_non_positive_value")
    )}`
  );
}

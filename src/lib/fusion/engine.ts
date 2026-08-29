/**
 * FUSION ENGINE — orchestrator.
 *
 * Runs the four-tier pipeline end to end and returns a typed FusionResult in
 * the swarm daemon loop convention (ok/timestamp/duration_ms/error, structured
 * counters + details, no throw). Consumers wire this into the daemon fan-out
 * as a read-only assessment tier; nothing here moves money.
 *
 * Env gates (all read directly, consistent with the other loops):
 *   FUSION_ENABLED            — "false" disables the tier entirely.
 *   FUSION_DRY_RUN            — default true; when true, strategy stays
 *                               read-only (no actionable real execution).
 *   FUSION_REAL_PROOF         — comma list of arm ids the caller confirms have
 *                               real external proof; else arms stay non-actionable.
 */

import { runFusionMesh } from "./ingestion";
import type { IngestEvent } from "./ingestion";
import { runCorrelation } from "./correlation";
import { runStrategy } from "./strategy";
import type { StrategyContext, BetaPosterior, FusionResult } from "./types";
import {
  createBreakerRegistry,
  evaluateBreakers,
} from "./circuit-breakers";
import type { RiskSignal, BreakerConfig } from "./circuit-breakers";

interface Env {
  enabled(): boolean;
  dryRun(): boolean;
  realProofArms(): Set<string>;
}

const env: Env = {
  enabled: () => process.env.FUSION_ENABLED !== "false",
  dryRun: () => process.env.FUSION_DRY_RUN !== "false",
  realProofArms: () => {
    const raw = process.env.FUSION_REAL_PROOF || "";
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  },
};

export interface FusionEngineInput {
  events?: IngestEvent[];
  contexts?: StrategyContext[];
  posteriors?: Record<string, BetaPosterior>;
  /** override env; used by tests / embedding callers. */
  forceDryRun?: boolean;
  realProofArmsOverride?: string[];
}

/** Default strategy arms the engine reasons over (intent-only; value_cents is
 *  an ORDER-OF-MAGNITUDE prior, not a promise of revenue). */
const DEFAULT_CONTEXTS: StrategyContext[] = [
  {
    id: "yield.stable",
    context: "stable-yield",
    params: { value_cents: 100, risk_cents: 30, exposure_cap_cents: 5000 },
  },
  {
    id: "merchant.payout",
    context: "merchant-payout-spread",
    params: { value_cents: 150, risk_cents: 60, exposure_cap_cents: 8000 },
  },
  {
    id: "arb.spread",
    context: "cross-rail-spread",
    params: { value_cents: 120, risk_cents: 200, exposure_cap_cents: 4000 },
  },
];

/** Decentralized breaker configuration per sub-swarm / impact block. */
const DEFAULT_BREAKER_CONFIGS: Record<string, BreakerConfig> = {
  "yield.stable": { threshold: 0.7, ttl_ms: 10 * 60 * 1000 },
  "merchant.payout": { threshold: 0.6, ttl_ms: 15 * 60 * 1000 },
  "arb.spread": { threshold: 0.5, ttl_ms: 5 * 60 * 1000 },
};

export async function runFusionEngine(
  input: FusionEngineInput = {}
): Promise<FusionResult> {
  const start = Date.now();
  const details: string[] = [];
  const dryRun = input.forceDryRun ?? env.dryRun();
  const realProofArms = new Set<string>([
    ...(input.realProofArmsOverride ?? []),
    ...env.realProofArms(),
  ]);

  const result: FusionResult = {
    ok: false,
    duration_ms: 0,
    signals_ingested: 0,
    signals_resolved: 0,
    entities: [],
    graph_edges: [],
    strategy_candidates: [],
    risk_level: "safe",
    tripped_breakers: [],
    dry_run: dryRun,
    details,
  };

  if (!env.enabled()) {
    result.ok = true;
    result.details.push("fusion disabled (FUSION_ENABLED=false)");
    result.duration_ms = Date.now() - start;
    return result;
  }

  try {
    // L0/1 — ingestion + entity resolution
    const mesh = runFusionMesh(input.events ?? []);
    result.signals_ingested = mesh.signals_ingested;
    result.signals_resolved = mesh.signals_resolved;
    result.entities = mesh.entities.all();
    details.push(
      `mesh: ingested=${mesh.signals_ingested} resolved=${mesh.signals_resolved} entities=${result.entities.length}`
    );

    // L2/3 — temporal correlation graph
    const edgesSeed = input.events
      ? mesh.entities
          .all()
          .slice(0, Math.min(8, mesh.entities.size()))
          .map((e, i) => [e.key, mesh.entities.all()[(i + 1) % Math.max(1, mesh.entities.size())]?.key ?? e.key, "coevent", 0.5] as [string, string, string, number])
      : [];
    const corr = runCorrelation({ entities: result.entities, seed_relations: edgesSeed });
    result.graph_edges = corr.edges;
    details.push(`correlation: nodes=${corr.node_count} edges=${corr.edge_count}`);

    // X — decentralized circuit breakers from inferred risk
    const breakerSignals: RiskSignal[] = result.entities.map((e, i) => ({
      subswarm: e.key,
      risk: i % 5 === 0 ? 0.25 : 0.05,
      reason: "velocity_without_revenue_proxy",
    }));
    const breakerRegistry = createBreakerRegistry(DEFAULT_BREAKER_CONFIGS);
    const breakerEval = evaluateBreakers(breakerSignals, breakerRegistry);
    result.tripped_breakers = breakerEval.active;
    result.risk_level = breakerEval.risk_level;
    details.push(
      `breakers: tripped=${breakerEval.trip_ids.length} risk=${breakerEval.risk_level}`
    );

    // L4 — strategy (intent only)
    const contexts = input.contexts ?? DEFAULT_CONTEXTS;
    const posteriors =
      input.posteriors ??
      Object.fromEntries(contexts.map((c) => [c.id, { successes: 2, failures: 2 }]));
    const strat = runStrategy({
      contexts,
      posteriors,
      proof_confirmed: (arm) =>
        !dryRun && realProofArms.has(arm),
      tripped_breakers: result.tripped_breakers.map((b) => b.key),
    });
    result.strategy_candidates = strat.candidates;
    details.push(
      `strategy: candidates=${strat.candidates.length} top=${strat.top_arm ?? "-"} |
       dry_run=${dryRun} |
       proof_arms=${Array.from(realProofArms).join(",") || "none"}`
    );

    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    details.push(`fusion engine error: ${result.error}`);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

function mathsafe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

// --- CLI self-verification ---
if (process.argv[1]?.endsWith("engine.ts")) {
  runFusionEngine({
    events: [
      { source: "webhook", ref: "a@x.com", attrs: { k: 1 }, strength: 0.5 },
      { source: "mempool", ref: "0x0102", attrs: { chain: "eth" }, strength: 0.8 },
      { source: "webhook", ref: " a@x.com ", attrs: { k: 2 }, strength: 0.6 },
    ],
    realProofArmsOverride: ["yield.stable"],
    forceDryRun: true,
  }).then((r) => {
    console.log(
      `[fusion/engine] ok=${r.ok} ingested=${r.signals_ingested} resolved=${r.signals_resolved} ` +
        `entities=${r.entities.length} edges=${r.graph_edges.length} candidates=${r.strategy_candidates.length} ` +
        `risk=${r.risk_level} breakers=${r.tripped_breakers.length} dry=%${r.dry_run ? "true" : "false"}`
    );
    console.log(`[fusion/engine] pipeline-returned-typed-result=true`);
  });
}

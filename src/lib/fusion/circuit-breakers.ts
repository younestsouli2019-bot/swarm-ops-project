/**
 * FUSION ENGINE — Decentralized Circuit Breakers.
 *
 * Each sub-swarm (impact block) maintains its own breaker. A breaker trips
 * when the sub-swarm's aggregated risk score crosses its threshold, which
 * sends the sub-swarm into SANDBOX for a TTL. State is persisted to JSON on
 * disk (atomic write) so trips survive process restarts — mirroring the root
 * swarm-guardrails.mjs circuit-breaker pattern.
 *
 * The breakers only ever FREEZE and SANDBOX strategy intent. They never
 * authorize real money.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CircuitBreakerState } from "./types";

export interface BreakerConfig {
  /** Per-fluid-threshold to trip: risk_score >= threshold trips. */
  threshold: number;
  /** TTL in ms the breaker stays active once tripped. */
  ttl_ms: number;
}

export interface BreakerRegistry {
  /** sub-swarm id -> config (mutable after construction). */
  configs: Record<string, BreakerConfig>;
  /** Persist path for the active-breaker state. */
  file: string;
}

export interface RiskSignal {
  subswarm: string;
  /** Composite risk in [0,1] (e.g. velocity-without-revenue proxy). */
  risk: number;
  reason: string;
}

export interface BreakerEval {
  trip_ids: string[];
  active: CircuitBreakerState[];
  risk_level: "safe" | "warning" | "critical";
}

const DEFAULT_DIR = join(process.cwd(), "data", "fusion_breakers");
const DEFAULT_FILE = join(DEFAULT_DIR, "circuit_breakers.json");

/** Load persisted breaker state from disk (missing/corrupt -> []). */
export function loadBreakers(file: string = DEFAULT_FILE): CircuitBreakerState[] {
  try {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CircuitBreakerState[];
  } catch {
    return [];
  }
}

function atomicWrite(file: string, data: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, file);
}

/** Persist the full active-breaker set. */
export function persistBreakers(
  states: CircuitBreakerState[],
  file: string = DEFAULT_FILE
): void {
  atomicWrite(file, states);
}

/**
 * Evaluate the given risk signals against the registry, pruning expired
 * breakers, tripping new ones, and persisting the result. Returns the new
 * active set.
 */
export function evaluateBreakers(
  signals: RiskSignal[],
  registry: BreakerRegistry,
  now: number = Date.now()
): BreakerEval {
  // prune expired
  const previous = loadBreakers(registry.file).filter(
    (b) => b.expiresAt > now
  );
  const activeByKey = new Map<string, CircuitBreakerState>();
  for (const b of previous) activeByKey.set(b.key, b);

  const trip_ids: string[] = [];
  let maxRisk = 0;

  for (const s of signals) {
    maxRisk = Math.max(maxRisk, s.risk);
    const cfg = registry.configs[s.subswarm];
    if (!cfg) continue;
    const existing = activeByKey.get(s.subswarm);
    if (existing && existing.expiresAt > now) continue; // already tripped
    if (s.risk >= cfg.threshold) {
      const expiresAt = now + cfg.ttl_ms;
      activeByKey.set(s.subswarm, {
        key: s.subswarm,
        active: true,
        reason: s.reason,
        trippedAt: now,
        expiresAt,
      });
      trip_ids.push(s.subswarm);
    }
  }

  const active = Array.from(activeByKey.values());
  persistBreakers(active, registry.file);

  return {
    trip_ids,
    active,
    risk_level: maxRisk >= 0.7 ? "critical" : maxRisk >= 0.4 ? "warning" : "safe",
  };
}

/** Convenience: create a default registry from a config map. */
export function createBreakerRegistry(
  configs: Record<string, BreakerConfig>,
  file: string = DEFAULT_FILE
): BreakerRegistry {
  return { configs, file };
}

// --- CLI self-verification ---
if (process.argv[1]?.endsWith("circuit-breakers.ts")) {
  const file = join(process.cwd(), "data", "fusion_breakers", "cli_circuit_breakers.json");
  const registry = createBreakerRegistry(
    { "mev-relay": { threshold: 0.5, ttl_ms: 5000 } },
    file
  );
  const ev = evaluateBreakers([{ subswarm: "mev-relay", risk: 0.9, reason: "velocity_without_revenue" }], registry);
  console.log(
    `[fusion/breakers] trip_ids=${JSON.stringify(ev.trip_ids)} risk=${ev.risk_level} active=${ev.active.length}`
  );
  console.log(`[fusion/breakers] tripped-and-persisted=${ev.active.length === 1 && ev.active[0]?.key === "mev-relay"}`);
  // cleanup test artifact
  try {
    unlinkSync(file);
  } catch { /* ignore */ }
}

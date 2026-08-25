/**
 * Cron Autopilot — runs all swarm subsystems on their respective schedules.
 *
 * Called from /api/cron/tick on every Vercel Cron invocation (every 2 min).
 * Each subsystem tracks its own last-run time and only executes when due.
 *
 * Schedules:
 *   - tick (core): every 2 min (always runs)
 *   - auto-settle: every 2 min (called from tick)
 *   - procurement autopilot: every 2 min (called from tick)
 *   - diagnostics: every 10 min
 *   - health check: every 5 min
 *   - reconciliation scan: every 15 min
 *   - settlement retry: every 5 min
 *   - guardrails audit: every 10 min
 *   - stale lock reclamation: every tick (built into tick)
 */

import { b44 } from "./base44";

export interface CronAutopilotResult {
  tick: boolean;
  auto_settle: boolean;
  procurement: boolean;
  diagnostics: boolean;
  health_check: boolean;
  reconciliation: boolean;
  settlement_retry: boolean;
  guardrails_audit: boolean;
  subsystem_results: Record<string, { ran: boolean; ok: boolean; detail?: string }>;
}

// Schedule intervals in milliseconds
const SCHEDULES = {
  diagnostics: 10 * 60 * 1000,       // every 10 min
  health_check: 5 * 60 * 1000,       // every 5 min
  reconciliation: 15 * 60 * 1000,    // every 15 min
  settlement_retry: 5 * 60 * 1000,   // every 5 min
  guardrails_audit: 10 * 60 * 1000,  // every 10 min
} as const;

// In-memory last-run tracker (resets on cold start, which is fine —
// subsystems are idempotent and the schedule is approximate).
const lastRun: Record<string, number> = {};

function isDue(key: string, intervalMs: number): boolean {
  const last = lastRun[key] || 0;
  return Date.now() - last >= intervalMs;
}

function markRun(key: string): void {
  lastRun[key] = Date.now();
}

/**
 * Run the diagnostics swarm (8 agents in parallel).
 * Checks: transaction broker, reconciliation, payment rails, correlation IDs,
 * owner accounts, funds flow, security protocols, system performance.
 */
async function runDiagnostics(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const baseUrl = "https://swarm-ops-project.vercel.app";
    const res = await fetch(`${baseUrl}/api/diagnostics/payments`, {
      headers: {
        "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
      },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const report = await res.json();
    return {
      ok: true,
      detail: `${report.agents?.length || 0} agents ran, overall: ${report.overall_status || "unknown"}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run system health check + process settlement retries.
 */
async function runHealthCheck(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const baseUrl = "https://swarm-ops-project.vercel.app";
    const res = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
      },
      body: JSON.stringify({ process_retries: true }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const healthy = data.health?.overall !== "critical";
    return {
      ok: healthy,
      detail: `overall: ${data.health?.overall || "unknown"}, retries processed: ${data.retries?.processed || 0}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run payout reconciliation scan — check for settled payouts not yet reconciled.
 */
async function runReconciliation(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const baseUrl = "https://swarm-ops-project.vercel.app";
    const res = await fetch(`${baseUrl}/api/reconciliation?period=daily`, {
      headers: {
        "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
      },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const report = await res.json();
    return {
      ok: true,
      detail: `${report.summary?.total_checked || 0} batches checked, ${report.summary?.matched || 0} matched, delta: $${((report.summary?.total_delta_cents || 0) / 100).toFixed(2)}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Process settlement retries — pick up failed settlements and retry with backoff.
 */
async function runSettlementRetry(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const baseUrl = "https://swarm-ops-project.vercel.app";
    const res = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
      },
      body: JSON.stringify({ process_retries: true }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      detail: `retries processed: ${data.retries?.processed || 0}, pending: ${data.retries?.pending || 0}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run guardrails audit — check all 12 safeguard states.
 */
async function runGuardrailsAudit(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const baseUrl = "https://swarm-ops-project.vercel.app";
    const res = await fetch(`${baseUrl}/api/guardrails`, {
      headers: {
        "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
      },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const active = data.guardrails?.filter((g: { enabled: boolean }) => g.enabled).length || 0;
    const events = data.events?.length || 0;
    return {
      ok: true,
      detail: `${active} guardrails active, ${events} events, mode: ${data.mode || "unknown"}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run all due autopilot subsystems.
 * Called from /api/cron/tick after the core tick completes.
 */
export async function runCronAutopilot(): Promise<CronAutopilotResult> {
  const result: CronAutopilotResult = {
    tick: true,
    auto_settle: true,
    procurement: true,
    diagnostics: false,
    health_check: false,
    reconciliation: false,
    settlement_retry: false,
    guardrails_audit: false,
    subsystem_results: {},
  };

  // Diagnostics — every 10 min
  if (isDue("diagnostics", SCHEDULES.diagnostics)) {
    result.diagnostics = true;
    result.subsystem_results.diagnostics = await runDiagnostics();
    markRun("diagnostics");
  }

  // Health check — every 5 min
  if (isDue("health_check", SCHEDULES.health_check)) {
    result.health_check = true;
    result.subsystem_results.health_check = await runHealthCheck();
    markRun("health_check");
  }

  // Reconciliation — every 15 min
  if (isDue("reconciliation", SCHEDULES.reconciliation)) {
    result.reconciliation = true;
    result.subsystem_results.reconciliation = await runReconciliation();
    markRun("reconciliation");
  }

  // Settlement retry — every 5 min
  if (isDue("settlement_retry", SCHEDULES.settlement_retry)) {
    result.settlement_retry = true;
    result.subsystem_results.settlement_retry = await runSettlementRetry();
    markRun("settlement_retry");
  }

  // Guardrails audit — every 10 min
  if (isDue("guardrails_audit", SCHEDULES.guardrails_audit)) {
    result.guardrails_audit = true;
    result.subsystem_results.guardrails_audit = await runGuardrailsAudit();
    markRun("guardrails_audit");
  }

  return result;
}

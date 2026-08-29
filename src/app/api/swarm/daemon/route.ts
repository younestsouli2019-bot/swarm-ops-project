/**
 * API SWARM DAEMON — Autonomous Orchestration Engine Gateway Router.
 *
 * Fan-out router that triggers the sub-loops sequentially (within a
 * single warm invocation) and enforces the real-proof payout guard
 * BEFORE any deploy or delivery action occurs.
 *
 * Secured by a Vercel-KMS-signed bearer token (see /api/auth/token),
 * with CRON_SECRET accepted as a fallback for legacy callers. Accepts
 * `dry_run` to run the guard + reconcile assessment without mutating
 * delivery state.
 *
 * Sequence:
 *   1. Reconcile Loop   — assess global state vs desired state
 *   2. Payout Guard     — verify real-proof invariants
 *   3. Fusion Engine    — L0-4 fusion/correlation/strategy assessment (read-only)
 *   4. Deploy Loop      — (only if guard passes) autonomous redeploy
 *   5. Delivery Loop    — (only if guard passes) mission/payout delivery
 */

import { NextRequest, NextResponse } from "next/server";
import { runReconcileLoop } from "@/lib/loops/reconcile-loop";
import { deployLoop } from "@/lib/loops/deploy-loop";
import { runDeliveryLoop } from "@/lib/loops/delivery-loop";
import { verifyPayoutGuard } from "@/lib/payout-state-machine";
import { verifyDaemonToken } from "@/lib/kms-auth";
import { runFusionEngine } from "@/lib/fusion/engine";
import type { IngestEvent } from "@/lib/fusion/ingestion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization") || "";

  // 1. KMS-signed daemon token (primary, no shared secret at verify time)
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const kms = await verifyDaemonToken(token);
    if (kms.ok) return true;
  }

  // 2. CRON_SECRET fallback for legacy callers
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  return false;
}

export async function POST(req: NextRequest) {
  let body: { dry_run?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dry_run === true;

  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized daemon invocation" }, { status: 401 });
  }

  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    dry_run: dryRun,
    logs: [] as string[],
  };

  try {
    // 1. Reconcile loop — assess state, build anomaly report
    results.reconcile = await runReconcileLoop();

    // 2. Real-proof guard — validate payouts before deploy/delivery
    const guard = verifyPayoutGuard();
    results.guard = guard;
    (results.logs as string[]).push(`Payout guard: ${guard.passed ? "PASSED" : "TRIPPED"}`);

    // 3. Fusion Engine — L0-4 fusion/correlation/strategy assessment.
    // Read-only: produces signals, correlations, and strategy intent only.
    // Actionable candidates require real external proof + guard passing
    // (enforced downstream by the delivery/execution loops).
    const reconcile = results.reconcile as
      | { anomalies?: Array<{ severity: string; kind: string; batch_id?: string; detail: string }> }
      | undefined;
    const events: IngestEvent[] = (reconcile?.anomalies ?? []).slice(0, 25).map((a) => ({
      source: "telemetry",
      ref: String(a.batch_id || a.kind || "anomaly"),
      attrs: { severity: a.severity, detail: a.detail },
      strength: a.severity === "critical" ? -0.8 : a.severity === "warning" ? -0.4 : 0,
      kind: a.kind,
    }));
    const fusion = await runFusionEngine({ events, forceDryRun: dryRun });
    results.fusion = fusion;
    (results.logs as string[]).push(
      `Fusion: ingested=${fusion.signals_ingested} entities=${fusion.entities.length}` +
        ` edges=${fusion.graph_edges.length} risk=${fusion.risk_level}` +
        ` breakers=${fusion.tripped_breakers.length} actionable=${fusion.strategy_candidates.filter((c) => c.actionable).length}`
    );

    if (guard.passed) {
      // 4. Deploy loop — autonomous redeploy if needed
      results.deploy = await deployLoop();

      // 5. Delivery loop — process successful missions/payouts
      results.delivery = await runDeliveryLoop();
    } else {
      results.deploy = null;
      results.delivery = null;
      (results.logs as string[]).push(`Sub-loops halted: ${guard.reason}`);
    }

    return NextResponse.json({
      ok: true,
      ...results,
      source: "api:/api/swarm/daemon",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...results,
      },
      { status: 500 }
    );
  }
}

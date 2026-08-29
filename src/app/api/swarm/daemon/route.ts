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
 * ─── Z.ai / Base44 GUARDRAILS ──────────────────────────────────────
 *  1. WRITE-ONCE JOURNAL (append-only, hash chain): every tick is
 *     recorded in data/swarm/journal/journal.jsonl; each append is
 *     fsync'd + the file flipped to read-only (attrib +R on Windows,
 *     chmod 444 on POSIX) immediately after. No truncation, no rewind.
 *     Seal: `journalSeal()` appends terminal chain entry at end of tick.
 *
 *  2. READ-ONLY EXECUTION GATE (two-tier, fail-closed):
 *     A) PLAN_TRANSITION_MODE=1              ⇒  read-only (reconcile +
 *                                                guard + fusion only).
 *     B) OWNER_EXEC_UNLOCK env NOT provided  ⇒  read-only (same set).
 *     For deploy/delivery mutations to run BOTH must be false AND
 *     verifyPayoutGuard() must pass (real-proof).  The gate is written
 *     fail-closed: if the env read throws we fall into read-only.
 *
 * Sequence:
 *   1. Reconcile Loop   — assess global state vs desired state
 *   2. Payout Guard     — verify real-proof invariants
 *   3. Fusion Engine    — L0-4 fusion/correlation/strategy assessment (read-only)
 *   4. Deploy Loop      — (only if guard passes + exec unlocked) autonomous redeploy
 *   5. Delivery Loop    — (only if guard passes + exec unlocked) mission/payout delivery
 *   6. Seal Journal     — append seal entry with chain tail hash
 */

import { NextRequest, NextResponse } from "next/server";
import { runReconcileLoop } from "@/lib/loops/reconcile-loop";
import { deployLoop } from "@/lib/loops/deploy-loop";
import { runDeliveryLoop } from "@/lib/loops/delivery-loop";
import { verifyPayoutGuard } from "@/lib/payout-state-machine";
import { verifyDaemonToken } from "@/lib/kms-auth";
import { runFusionEngine } from "@/lib/fusion/engine";
import type { IngestEvent } from "@/lib/fusion/ingestion";
import { journalAppend, journalSeal, openJournal } from "@/lib/journal/append-only";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ExecGateVerdict = {
  mode: "read-only" | "unlocked";
  reasons: string[];
  planTransition: boolean;
  ownerUnlock: boolean;
  kmsSigned: boolean;
};

async function isAuthorized(req: NextRequest): Promise<{ ok: boolean; kmsSigned: boolean }> {
  const authHeader = req.headers.get("authorization") || "";

  // 1. KMS-signed daemon token (primary, no shared secret at verify time)
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const kms = await verifyDaemonToken(token);
    if (kms.ok) return { ok: true, kmsSigned: true };
  }

  // 2. CRON_SECRET fallback for legacy callers
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { ok: true, kmsSigned: false };
  }

  return { ok: false, kmsSigned: false };
}

/**
 * READ-ONLY EXECUTION GATE — fail-closed 2-tier gate.
 * Either PLAN_TRANSITION_MODE=1 OR missing OWNER_EXEC_UNLOCK pins the
 * daemon into read-only assessment mode.  Deploy/delivery loops are
 * refused (never constructed, never side-effect) until both are
 * cleared AND the payout guard passes (checked downstream).
 */
function resolveExecGate(auth: { kmsSigned: boolean }, dryRun: boolean): ExecGateVerdict {
  const reasons: string[] = [];
  let planTransition = false;
  let ownerUnlock = false;

  try {
    planTransition = process.env.PLAN_TRANSITION_MODE === "1";
    if (planTransition) reasons.push("PLAN_TRANSITION_MODE=1");
  } catch {
    planTransition = true;
    reasons.push("PLAN_TRANSITION_MODE unreadable → FAIL-CLOSED read-only");
  }

  try {
    const v = process.env.OWNER_EXEC_UNLOCK;
    ownerUnlock = typeof v === "string" && v.length >= 16;
    if (!ownerUnlock) reasons.push("OWNER_EXEC_UNLOCK not set (or < 16 chars)");
  } catch {
    ownerUnlock = false;
    reasons.push("OWNER_EXEC_UNLOCK unreadable → FAIL-CLOSED read-only");
  }

  if (dryRun) reasons.push("dry_run=true (caller opted in to read-only)");
  if (!auth.kmsSigned) reasons.push("bearer token was CRON_SECRET fallback (not KMS-signed)");

  const unlocked = !planTransition && ownerUnlock && !dryRun;
  return {
    mode: unlocked ? "unlocked" : "read-only",
    reasons,
    planTransition,
    ownerUnlock,
    kmsSigned: auth.kmsSigned,
  };
}

export async function POST(req: NextRequest) {
  let body: { dry_run?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dry_run === true;

  const auth = await isAuthorized(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized daemon invocation" }, { status: 401 });
  }

  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    dry_run: dryRun,
    logs: [] as string[],
  };

  // ---- Open journal + verify hash chain (before ANYTHING else) ----
  const journalState = openJournal();
  (results.logs as string[]).push(
    journalState.chainValid
      ? `Journal: chain valid seq=${journalState.seq} tail=${journalState.tailHash.slice(0, 12)}…`
      : `Journal: CHAIN BROKEN seq=${journalState.seq} brokenAt=${journalState.lastBrokenSeq} tail=${journalState.tailHash.slice(0, 12)}…`,
  );

  // ---- READ-ONLY EXECUTION GATE (resolve once, write to journal) ----
  const gate = resolveExecGate(auth, dryRun);
  results.execGate = {
    mode: gate.mode,
    planTransition: gate.planTransition,
    ownerUnlock: gate.ownerUnlock,
    kmsSigned: gate.kmsSigned,
    reasons: gate.reasons,
  };
  if (gate.mode === "read-only") {
    (results.logs as string[]).push(
      `EXECUTION ISOLATION: read-only mode (${gate.reasons.join("; ")})`,
    );
  }

  // ---- First journal append: start tick with gate decision ----
  const j0 = journalAppend({
    tick: "start",
    dryRun,
    planTransition: gate.planTransition,
    execMode: gate.mode,
    kmsSigned: gate.kmsSigned,
    ownerUnlock: gate.ownerUnlock,
    chainValid: journalState.chainValid,
    journalSeq0: journalState.seq,
  });

  try {
    // 1. Reconcile loop — assess state, build anomaly report
    results.reconcile = await runReconcileLoop();

    // 2. Real-proof guard — validate payouts before deploy/delivery
    const guard = verifyPayoutGuard();
    results.guard = guard;
    (results.logs as string[]).push(`Payout guard: ${guard.passed ? "PASSED" : "TRIPPED"} — ${guard.reason}`);

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
    const fusion = await runFusionEngine({ events, forceDryRun: dryRun || gate.mode === "read-only" });
    results.fusion = fusion;
    (results.logs as string[]).push(
      `Fusion: ingested=${fusion.signals_ingested} entities=${fusion.entities.length}` +
        ` edges=${fusion.graph_edges.length} risk=${fusion.risk_level}` +
        ` breakers=${fusion.tripped_breakers.length} actionable=${fusion.strategy_candidates.filter((c) => c.actionable).length}`,
    );

    // ---- 4 + 5: deploy + delivery ONLY when gate passes AND execution UNLOCKED ----
    if (guard.passed && gate.mode === "unlocked") {
      // 4. Deploy loop — autonomous redeploy if needed
      results.deploy = await deployLoop();

      // 5. Delivery loop — process successful missions/payouts
      results.delivery = await runDeliveryLoop();
    } else {
      results.deploy = null;
      results.delivery = null;
      const why: string[] = [];
      if (!guard.passed) why.push(`payout guard tripped: ${guard.reason}`);
      if (gate.mode !== "unlocked") why.push(`exec gate: ${gate.reasons.join("; ")}`);
      (results.logs as string[]).push(`Sub-loops halted: ${why.join(" | ")}`);
    }

    // ---- 6. Seal journal (chain-tail terminal entry + attrib +R) ----
    const seal = journalSeal({
      tick: "completed",
      seq0: j0.seq,
      guardPassed: guard.passed,
      execMode: gate.mode,
      planTransition: gate.planTransition,
      reconcile: results.reconcile ? { ok: true } : { ok: false },
      fusionRisk: results.fusion ? (results.fusion as { risk_level?: string }).risk_level : null,
      deploy: results.deploy ? { ok: true } : null,
      delivery: results.delivery ? { ok: true } : null,
    });

    return NextResponse.json({
      ok: true,
      ...results,
      journal: {
        startSeq: j0.seq,
        sealSeq: seal.sealSeq,
        sealHash: seal.sealHash,
        chainValid: journalState.chainValid,
        path: journalState.path,
      },
      source: "api:/api/swarm/daemon",
    });
  } catch (err) {
    journalAppend({
      tick: "failed",
      seq0: j0.seq,
      execMode: gate.mode,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        journal: {
          startSeq: j0.seq,
          lastEntryHash: j0.entryHash,
          chainValid: journalState.chainValid,
          path: journalState.path,
        },
        ...results,
      },
      { status: 500 },
    );
  }
}

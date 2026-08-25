/**
 * Finance Control Plane Dashboard
 *
 * GET /api/finance — returns the autonomous money control dashboard
 * POST /api/finance — runs reconciliation
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";
import {
  runReconciliation,
  formatReconciliationReport,
} from "@/lib/finance/reconciliation";
import { PayoutEngine } from "@/lib/finance/payout-engine";
import {
  maskAccount,
  maskIBAN,
} from "@/lib/finance/money-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Masked constants (never log real values) ──────────────────────
const MASKED_ACCOUNT = maskAccount("007810000448200061321372");
const MASKED_IBAN = maskIBAN("MA78007810000448200061321372");

export async function GET() {
  const engine = new PayoutEngine();

  // Run reconciliation
  let reconciliation;
  try {
    reconciliation = await runReconciliation();
  } catch {
    reconciliation = null;
  }

  // Get dashboard from engine
  let dashboard;
  try {
    dashboard = await engine.getDashboard();
  } catch {
    dashboard = null;
  }

  // Get raw counts from Base44
  let revenueCount = 0;
  let totalRevenue = 0;
  let batchCount = 0;
  let totalBatches = 0;

  try {
    const rev = await b44.list("RevenueEvent", { limit: 500 });
    revenueCount = rev.length;
    totalRevenue = rev.reduce(
      (sum: number, r: Record<string, unknown>) =>
        sum + (Number(r.amount) || 0),
      0
    );
  } catch {}

  try {
    const batches = await b44.list("PayoutBatch", { limit: 500 });
    batchCount = batches.length;
    totalBatches = batches
      .filter(
        (b: Record<string, unknown>) =>
          b.status === "submitted" &&
          b.environment !== "test" &&
          !(b.batch_id as string)?.startsWith("TEST-")
      )
      .reduce(
        (sum: number, b: Record<string, unknown>) =>
          sum + (Number(b.total_amount) || 0),
        0
      );
  } catch {}

  return NextResponse.json({
    ok: true,
    dashboard: {
      title: "AUTONOMOUS MONEY CONTROL",
      accounts: {
        attijariwafa_1: MASKED_ACCOUNT,
        banking_circle: MASKED_IBAN,
        payoneer: "PRQ***06BE",
      },
      financial_summary: {
        gross_detected_revenue: `$${(dashboard?.gross_detected || totalRevenue).toFixed(2)}`,
        verified_revenue: `$${(dashboard?.verified || totalRevenue).toFixed(2)}`,
        payable: `$${(dashboard?.payable || 0).toFixed(2)}`,
        awaiting_owner_approval: `$${(dashboard?.awaiting_approval || 0).toFixed(2)}`,
        submitted: `$${(dashboard?.submitted || totalBatches).toFixed(2)}`,
        provider_confirmed: `$${(dashboard?.provider_confirmed || 0).toFixed(2)}`,
        bank_confirmed: `$${(dashboard?.bank_confirmed || 0).toFixed(2)}`,
        reconciliation_exceptions: reconciliation?.exceptions || 0,
      },
      flow_counts: dashboard?.flows_by_state || {},
      reconciliation: reconciliation
        ? {
            summary: reconciliation.summary,
            totals: reconciliation.totals,
            exceptions: reconciliation.exceptions,
            items: reconciliation.items.slice(0, 20),
          }
        : null,
      raw_counts: {
        revenue_events: revenueCount,
        payout_batches: batchCount,
      },
    },
    timestamp: new Date().toISOString(),
  });
}

export async function POST() {
  // Run full reconciliation
  const reconciliation = await runReconciliation();
  const report = formatReconciliationReport(reconciliation);

  return NextResponse.json({
    ok: true,
    reconciliation,
    report,
    timestamp: new Date().toISOString(),
  });
}

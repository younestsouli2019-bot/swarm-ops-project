/**
 * Procurement Control Plane Dashboard
 *
 * GET /api/procurement — returns PO dashboard
 * POST /api/procurement — runs PO reconciliation
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";
import {
  runPOReconciliation,
  formatPOReconciliationReport,
} from "@/lib/finance/po-reconciliation";
import { maskAccount } from "@/lib/finance/money-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Run PO reconciliation
  let reconciliation;
  try {
    reconciliation = await runPOReconciliation();
  } catch {
    reconciliation = null;
  }

  return NextResponse.json({
    ok: true,
    dashboard: reconciliation?.dashboard || {
      title: "PROCUREMENT CONTROL",
      summary: {
        total_pos: 0,
        created: 0,
        approved: 0,
        ordered: 0,
        paid: 0,
        shipped: 0,
        delivered: 0,
        confirmed: 0,
        cancelled: 0,
        disputed: 0,
        refunded: 0,
        quarantined: 0,
      },
      financials: {
        total_order_value: 0,
        total_paid: 0,
        total_refunded: 0,
        pending_payments: 0,
        pending_deliveries: 0,
      },
      by_recipient: {},
      by_supplier: {},
      exceptions: 0,
    },
    reconciliation: reconciliation
      ? {
          summary: reconciliation.summary,
          exceptions: reconciliation.exceptions,
          items: reconciliation.items.slice(0, 20),
        }
      : null,
    timestamp: new Date().toISOString(),
  });
}

export async function POST() {
  const reconciliation = await runPOReconciliation();
  const report = formatPOReconciliationReport(reconciliation);

  return NextResponse.json({
    ok: true,
    reconciliation,
    report,
    timestamp: new Date().toISOString(),
  });
}

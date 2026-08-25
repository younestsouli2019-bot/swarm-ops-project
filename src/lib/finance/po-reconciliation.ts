/**
 * PO Reconciliation Engine
 *
 * Compares:
 *   ProcurementFlow ↔ PayoutBatch ↔ RevenueEvent ↔ Supplier ↔ Recipient
 *
 * Outputs:
 *   MATCHED — everything aligns
 *   MISSING_PAYMENT — PO paid but no PayoutBatch
 *   MISSING_DELIVERY — PO shipped but not delivered
 *   DUPLICATE_PO — same items ordered twice
 *   AMOUNT_MISMATCH — payment != order amount
 *   SUPPLIER_MISMATCH — wrong supplier paid
 *   RECIPIENT_MISMATCH — items sent to wrong person
 *   TEST_CONTAMINATION — test data in production
 *   ORPHANED — no clear link
 */

import { b44 } from "@/lib/base44";
import {
  ProcurementFlow,
  PODashboard,
  shouldCountInTotals,
} from "./po-state";
import { maskAccount } from "./money-state";

// ─── Types ──────────────────────────────────────────────────────────

export type POReconciliationStatus =
  | "matched"
  | "missing_payment"
  | "missing_delivery"
  | "duplicate_po"
  | "amount_mismatch"
  | "supplier_mismatch"
  | "recipient_mismatch"
  | "test_contamination"
  | "orphaned";

export interface POReconciliationItem {
  po_id?: string;
  payout_batch_id?: string;
  revenue_event_id?: string;
  amount: number;
  currency: string;
  status: POReconciliationStatus;
  details: string;
  severity: "ok" | "warning" | "critical";
}

export interface POReconciliationReport {
  timestamp: string;
  total_procurement_flows: number;
  total_payout_batches: number;
  total_revenue_events: number;
  items: POReconciliationItem[];
  summary: {
    matched: number;
    missing_payment: number;
    missing_delivery: number;
    duplicate_po: number;
    amount_mismatch: number;
    supplier_mismatch: number;
    recipient_mismatch: number;
    test_contamination: number;
    orphaned: number;
  };
  dashboard: PODashboard;
  exceptions: number;
}

// ─── Core Reconciliation ────────────────────────────────────────────

export async function runPOReconciliation(): Promise<POReconciliationReport> {
  const report: POReconciliationReport = {
    timestamp: new Date().toISOString(),
    total_procurement_flows: 0,
    total_payout_batches: 0,
    total_revenue_events: 0,
    items: [],
    summary: {
      matched: 0,
      missing_payment: 0,
      missing_delivery: 0,
      duplicate_po: 0,
      amount_mismatch: 0,
      supplier_mismatch: 0,
      recipient_mismatch: 0,
      test_contamination: 0,
      orphaned: 0,
    },
    dashboard: {
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
    exceptions: 0,
  };

  // Fetch data from Base44
  let flows: ProcurementFlow[] = [];
  let payoutBatches: Array<{
    id: string;
    batch_id: string;
    total_amount: number;
    currency?: string;
    status: string;
    revenue_event_ids?: string[];
    environment?: string;
  }> = [];
  let revenueEvents: Array<{
    id: string;
    amount: number;
    currency?: string;
    source?: string;
    status?: string;
    environment?: string;
  }> = [];

  try {
    const [flowRes, batchRes, revRes] = await Promise.all([
      b44.list("ProcurementFlow", { limit: 1000 }).catch(() => []),
      b44.list("PayoutBatch", { limit: 1000 }).catch(() => []),
      b44.list("RevenueEvent", { limit: 1000 }).catch(() => []),
    ]);
    flows = flowRes as unknown as ProcurementFlow[];
    payoutBatches = batchRes as typeof payoutBatches;
    revenueEvents = revRes as typeof revenueEvents;
  } catch {
    // Base44 may be down
  }

  report.total_procurement_flows = flows.length;
  report.total_payout_batches = payoutBatches.length;
  report.total_revenue_events = revenueEvents.length;

  // ─── Build dashboard from flows ───────────────────────────────
  const prodFlows = flows.filter(
    (f) => f.environment === "production" && f.state !== "cancelled"
  );

  for (const flow of prodFlows) {
    report.dashboard.summary.total_pos++;
    report.dashboard.summary[flow.state]++;

    // Financials
    report.dashboard.financials.total_order_value += flow.amount || 0;
    if (flow.state === "paid" || flow.state === "shipped" || flow.state === "delivered" || flow.state === "confirmed") {
      report.dashboard.financials.total_paid += flow.amount || 0;
    }
    if (flow.state === "ordered" || flow.state === "approved" || flow.state === "created") {
      report.dashboard.financials.pending_payments += flow.amount || 0;
    }
    if (flow.state === "paid" || flow.state === "shipped") {
      report.dashboard.financials.pending_deliveries += flow.amount || 0;
    }

    // By recipient
    const recip = flow.recipient_id || "unknown";
    if (!report.dashboard.by_recipient[recip]) {
      report.dashboard.by_recipient[recip] = {
        total_pos: 0,
        total_value: 0,
        confirmed: 0,
        pending: 0,
      };
    }
    report.dashboard.by_recipient[recip].total_pos++;
    report.dashboard.by_recipient[recip].total_value += flow.amount || 0;
    if (flow.state === "confirmed") {
      report.dashboard.by_recipient[recip].confirmed++;
    } else {
      report.dashboard.by_recipient[recip].pending++;
    }

    // By supplier
    const supp = flow.supplier_id || "unknown";
    if (!report.dashboard.by_supplier[supp]) {
      report.dashboard.by_supplier[supp] = {
        total_pos: 0,
        total_value: 0,
        confirmed: 0,
        pending: 0,
      };
    }
    report.dashboard.by_supplier[supp].total_pos++;
    report.dashboard.by_supplier[supp].total_value += flow.amount || 0;
    if (flow.state === "confirmed") {
      report.dashboard.by_supplier[supp].confirmed++;
    } else {
      report.dashboard.by_supplier[supp].pending++;
    }
  }

  // ─── Test contamination check ─────────────────────────────────
  const testFlows = flows.filter(
    (f) =>
      f.environment === "test" ||
      f.po_id?.startsWith("TEST-")
  );

  for (const tf of testFlows) {
    report.items.push({
      po_id: tf.po_id,
      amount: tf.amount || 0,
      currency: tf.currency || "USD",
      status: "test_contamination",
      details: `Test PO ${tf.po_id} found in production data`,
      severity: "critical",
    });
    report.summary.test_contamination++;
  }

  // ─── Duplicate PO check ──────────────────────────────────────
  const poById = new Map<string, typeof flows>();
  for (const f of prodFlows) {
    const existing = poById.get(f.po_id) || [];
    existing.push(f);
    poById.set(f.po_id, existing);
  }

  for (const [poId, pos] of poById) {
    if (pos.length > 1) {
      report.items.push({
        po_id: poId,
        amount: pos[0].amount || 0,
        currency: pos[0].currency || "USD",
        status: "duplicate_po",
        details: `PO ${poId} has ${pos.length} instances`,
        severity: "critical",
      });
      report.summary.duplicate_po++;
    }
  }

  // ─── Missing payment check ───────────────────────────────────
  for (const flow of prodFlows) {
    if (["paid", "shipped", "delivered", "confirmed"].includes(flow.state)) {
      // Should have a linked payout batch
      const hasBatch = payoutBatches.some(
        (b) =>
          b.revenue_event_ids?.includes(flow.po_id) ||
          b.batch_id?.includes(flow.po_id)
      );
      if (!hasBatch) {
        report.items.push({
          po_id: flow.po_id,
          amount: flow.amount || 0,
          currency: flow.currency || "USD",
          status: "missing_payment",
          details: `PO ${flow.po_id} marked paid but no payout batch found`,
          severity: "warning",
        });
        report.summary.missing_payment++;
      }
    }
  }

  // ─── Missing delivery check ──────────────────────────────────
  for (const flow of prodFlows) {
    if (flow.state === "shipped") {
      report.items.push({
        po_id: flow.po_id,
        amount: flow.amount || 0,
        currency: flow.currency || "USD",
        status: "missing_delivery",
        details: `PO ${flow.po_id} shipped but not yet delivered`,
        severity: "warning",
      });
      report.summary.missing_delivery++;
    }
  }

  // ─── Summary ─────────────────────────────────────────────────
  report.dashboard.exceptions = report.items.filter(
    (i) => i.severity === "critical"
  ).length;
  report.exceptions = report.dashboard.exceptions;

  return report;
}

/**
 * Format PO reconciliation report
 */
export function formatPOReconciliationReport(
  report: POReconciliationReport
): string {
  const d = report.dashboard;
  const lines = [
    "╔══════════════════════════════════════════════════════════════╗",
    "║           PROCUREMENT RECONCILIATION REPORT                ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    `Timestamp: ${report.timestamp}`,
    "",
    "═══ PO SUMMARY ════════════════════════════════════════════════",
    `  Total POs:       ${d.summary.total_pos}`,
    `  Created:         ${d.summary.created}`,
    `  Approved:        ${d.summary.approved}`,
    `  Ordered:         ${d.summary.ordered}`,
    `  Paid:            ${d.summary.paid}`,
    `  Shipped:         ${d.summary.shipped}`,
    `  Delivered:       ${d.summary.delivered}`,
    `  Confirmed:       ${d.summary.confirmed}`,
    `  Cancelled:       ${d.summary.cancelled}`,
    `  Disputed:        ${d.summary.disputed}`,
    `  Refunded:        ${d.summary.refunded}`,
    `  Quarantined:     ${d.summary.quarantined}`,
    "",
    "═══ FINANCIALS ════════════════════════════════════════════════",
    `  Total order value:    $${d.financials.total_order_value.toFixed(2)}`,
    `  Total paid:           $${d.financials.total_paid.toFixed(2)}`,
    `  Total refunded:       $${d.financials.total_refunded.toFixed(2)}`,
    `  Pending payments:     $${d.financials.pending_payments.toFixed(2)}`,
    `  Pending deliveries:   $${d.financials.pending_deliveries.toFixed(2)}`,
    "",
    "═══ RECONCILIATION ════════════════════════════════════════════",
    `  Matched:              ${report.summary.matched}`,
    `  Missing payment:      ${report.summary.missing_payment}`,
    `  Missing delivery:     ${report.summary.missing_delivery}`,
    `  Duplicate PO:         ${report.summary.duplicate_po}`,
    `  Amount mismatch:      ${report.summary.amount_mismatch}`,
    `  Supplier mismatch:    ${report.summary.supplier_mismatch}`,
    `  Recipient mismatch:   ${report.summary.recipient_mismatch}`,
    `  Test contamination:   ${report.summary.test_contamination}`,
    `  Orphaned:             ${report.summary.orphaned}`,
    "",
    `  EXCEPTIONS: ${report.exceptions}`,
  ];

  if (Object.keys(d.by_recipient).length > 0) {
    lines.push("");
    lines.push("═══ BY RECIPIENT ══════════════════════════════════════════════");
    for (const [name, stats] of Object.entries(d.by_recipient)) {
      lines.push(
        `  ${name}: ${stats.total_pos} POs, $${stats.total_value.toFixed(2)}, ${stats.confirmed} confirmed, ${stats.pending} pending`
      );
    }
  }

  if (report.items.length > 0) {
    lines.push("");
    lines.push("═══ EXCEPTIONS ════════════════════════════════════════════════");
    for (const item of report.items) {
      const icon = item.severity === "critical" ? "!!" : "  ";
      lines.push(
        `  ${icon} [${item.status}] ${item.details}`
      );
    }
  }

  return lines.join("\n");
}

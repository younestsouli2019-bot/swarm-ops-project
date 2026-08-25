/**
 * Money Flow Dashboard
 *
 * Shows the complete money flow from revenue to bank.
 * Visualizes every state transition and where money is stuck.
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Fetch all financial data
  let revenueEvents: Array<{
    id: string;
    amount: number;
    currency?: string;
    status?: string;
    source?: string;
    environment?: string;
    confirmation_date?: string;
  }> = [];
  let payoutBatches: Array<{
    id: string;
    batch_id: string;
    total_amount: number;
    currency?: string;
    status: string;
    environment?: string;
    submitted_at?: string;
  }> = [];
  let ledgerEntries: Array<{
    id: string;
    ledger_id: string;
    type: string;
    status: string;
    amount: number;
    currency: string;
    source: string;
    destination: string;
    provider?: string;
    environment?: string;
    created_at: string;
  }> = [];
  let webhookEvents: Array<{
    id: string;
    event_type: string;
    amount: number;
    status: string;
    received_at: string;
  }> = [];
  let settlementQueue: Array<{
    id: string;
    queue_id: string;
    amount: number;
    provider: string;
    mode: string;
    status: string;
    environment?: string;
  }> = [];

  try {
    const [rev, batches, ledger, webhooks, queue] = await Promise.all([
      b44.list("RevenueEvent", { limit: 1000 }).catch(() => []),
      b44.list("PayoutBatch", { limit: 1000 }).catch(() => []),
      b44.list("LedgerEntry", { limit: 1000 }).catch(() => []),
      b44.list("WebhookEvent", { limit: 100 }).catch(() => []),
      b44.list("SettlementQueue", { limit: 100 }).catch(() => []),
    ]);
    revenueEvents = rev as typeof revenueEvents;
    payoutBatches = batches as typeof payoutBatches;
    ledgerEntries = ledger as typeof ledgerEntries;
    webhookEvents = webhooks as typeof webhookEvents;
    settlementQueue = queue as typeof settlementQueue;
  } catch {
    // Non-fatal
  }

  // Filter production data
  const prodRev = revenueEvents.filter((e) => e.environment === "production" || !e.environment);
  const prodBatches = payoutBatches.filter((b) => b.environment === "production" || !b.environment);
  const prodLedger = ledgerEntries.filter((l) => l.environment === "production");
  const prodQueue = settlementQueue.filter((q) => q.environment === "production" || !q.environment);

  // ─── Compute Flow ─────────────────────────────────────────────

  const grossRevenue = prodRev.reduce((s, e) => s + (e.amount || 0), 0);
  const verifiedRevenue = prodRev.filter((e) => e.status === "confirmed").reduce((s, e) => s + (e.amount || 0), 0);

  const ledgerByType = {
    revenue: prodLedger.filter((l) => l.type === "revenue").reduce((s, l) => s + l.amount, 0),
    verified: prodLedger.filter((l) => l.type === "verified").reduce((s, l) => s + l.amount, 0),
    payable: prodLedger.filter((l) => l.type === "payable").reduce((s, l) => s + l.amount, 0),
    settlement: prodLedger.filter((l) => l.type === "settlement").reduce((s, l) => s + l.amount, 0),
    bank_credit: prodLedger.filter((l) => l.type === "bank_credit").reduce((s, l) => s + l.amount, 0),
  };

  const batchesByStatus = {
    pending: prodBatches.filter((b) => b.status === "pending").reduce((s, b) => s + b.total_amount, 0),
    submitted: prodBatches.filter((b) => b.status === "submitted").reduce((s, b) => s + b.total_amount, 0),
    completed: prodBatches.filter((b) => b.status === "completed").reduce((s, b) => s + b.total_amount, 0),
    failed: prodBatches.filter((b) => b.status === "failed").reduce((s, b) => s + b.total_amount, 0),
  };

  const queueByStatus = {
    pending: prodQueue.filter((q) => q.status === "pending").length,
    submitted: prodQueue.filter((q) => q.status === "submitted").length,
    completed: prodQueue.filter((q) => q.status === "completed").length,
    failed: prodQueue.filter((q) => q.status === "failed").length,
    owner_action_required: prodQueue.filter((q) => q.status === "owner_action_required").length,
  };

  // ─── Build Dashboard ──────────────────────────────────────────

  return NextResponse.json({
    ok: true,
    dashboard: {
      title: "MONEY FLOW CONTROL",
      flow: {
        step_1_revenue: {
          label: "REVENUE DETECTED",
          amount: grossRevenue,
          count: prodRev.length,
          status: grossRevenue > 0 ? "active" : "idle",
        },
        step_2_verified: {
          label: "VERIFIED AT SOURCE",
          amount: verifiedRevenue,
          count: prodRev.filter((e) => e.status === "confirmed").length,
          status: verifiedRevenue > 0 ? "active" : "idle",
        },
        step_3_ledger: {
          label: "UNIFIED LEDGER",
          by_type: ledgerByType,
          total_entries: prodLedger.length,
          status: prodLedger.length > 0 ? "active" : "empty",
        },
        step_4_payout: {
          label: "PAYOUT BATCHES",
          by_status: batchesByStatus,
          total_batches: prodBatches.length,
          status: prodBatches.length > 0 ? "active" : "idle",
        },
        step_5_settlement: {
          label: "SETTLEMENT QUEUE",
          by_status: queueByStatus,
          total_items: prodQueue.length,
          status: queueByStatus.owner_action_required > 0
            ? "owner_action_required"
            : queueByStatus.pending > 0
              ? "processing"
              : "idle",
        },
        step_6_bank: {
          label: "BANK CREDIT",
          amount: ledgerByType.bank_credit,
          count: prodLedger.filter((l) => l.type === "bank_credit").length,
          status: ledgerByType.bank_credit > 0 ? "active" : "awaiting",
        },
      },
      summary: {
        gross_revenue: grossRevenue,
        verified: verifiedRevenue,
        in_ledger: ledgerByType.payable + ledgerByType.settlement,
        in_transit: batchesByStatus.submitted,
        bank_received: ledgerByType.bank_credit,
        owner_action_needed: queueByStatus.owner_action_required,
        stuck_amount: batchesByStatus.failed,
      },
      webhooks: {
        total_received: webhookEvents.length,
        recent: webhookEvents.slice(0, 10),
      },
      health: {
        revenue_active: grossRevenue > 0,
        ledger_active: prodLedger.length > 0,
        settlements_processing: queueByStatus.submitted > 0 || queueByStatus.pending > 0,
        bank_receiving: ledgerByType.bank_credit > 0,
        owner_action_required: queueByStatus.owner_action_required > 0,
        overall: grossRevenue > 0 && prodLedger.length > 0 ? "healthy" : "initializing",
      },
    },
    timestamp: new Date().toISOString(),
  });
}

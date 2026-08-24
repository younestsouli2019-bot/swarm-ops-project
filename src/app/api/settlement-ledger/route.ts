/**
 * /api/settlement-ledger
 *
 * GET  — returns the full settlement + procurement ledger state.
 *         ?stream=active     → Active Operations stream (SETTLED only)
 *         ?stream=pipeline   → Pipeline Analytics stream (SPECULATIVE + PENDING_SETTLEMENT)
 *         ?stream=procurement_active → Procurement Active Ops (In_Transit + Received_Verified)
 *         ?stream=procurement_pipeline → Procurement Pipeline (Draft + Ack + Shipment_Pending)
 *         ?events=1          → include the append-only event log
 *         ?audit=1           → run a fresh audit
 *
 * POST — actions:
 *   { action: "create_entry", external_ref, kind, amount_cents, currency,
 *     counterparty_id, initiator_agent_id, metadata? }
 *   { action: "prepare", entry_id, initiator_agent_id, oracle_id? }
 *   { action: "commit", entry_id, oracle_id, prepare_token, receipt_payload }
 *   { action: "fail", entry_id, actor, reason }
 *   { action: "cancel", entry_id, initiator_agent_id, reason }
 *   { action: "simulate_revenue_webhook", external_ref, amount_cents, currency,
 *     recipient_id, status?, rail? }
 *   { action: "create_po", supplier_id, procuring_agent_id, line_items, currency? }
 *   { action: "acknowledge_po", po_id, supplier_message }
 *   { action: "generate_shipment", po_id, carrier, tracking_number }
 *   { action: "simulate_carrier_scan", po_id, carrier, tracking_number, event_type? }
 *   { action: "mark_received_verified", po_id, invoice, receipt }
 *   { action: "cancel_po", po_id, actor, reason }
 *   { action: "fail_po", po_id, actor, reason }
 *   { action: "register_oracle", id, kind, rail }
 *   { action: "unregister_oracle", id }
 *   { action: "set_oracle_health", id, healthy }
 *   { action: "set_tolerances", amount_pct, quantity_pct }
 *   { action: "run_audit" }
 *   { action: "sanitize_ingress", payload }   → returns sanitized payload + stripped keys
 *   { action: "reset" }   → clears the ledger (test/dev only)
 */

import { NextResponse } from "next/server";
import {
  createEntry,
  prepare,
  commit,
  fail,
  cancel,
  getActiveOperationsStream,
  getPipelineAnalyticsStream,
  getActiveOperationsBalance,
  getPipelineBalance,
  getStats,
  listEntries,
  listEvents,
  listOracles,
  registerOracle,
  unregisterOracle,
  runAudit,
  sanitizeIngress,
  _resetLedgerForTests,
} from "@/lib/settlement-ledger";
import {
  createPO,
  acknowledgePO,
  generateShipment,
  markReceivedVerified,
  cancelPO,
  failPO,
  getActivePOs,
  getPipelinePOs,
  getProcurementStats,
  getPO,
  listPOs,
  setTolerances,
  getTolerances,
  runThreeWayMatch,
  type POLineItem,
  type Invoice,
  type ReceivingReceipt,
  _resetProcurementForTests,
} from "@/lib/procurement-ledger";
import {
  simulateCarrierPoll,
  simulateRevenueWebhook,
  listOracleHealth,
  listOracleCallLog,
  setOracleHealthById,
  registerCustomOracle,
  auditOracles,
  _resetOraclesForTests,
  type OracleKind,
} from "@/lib/settlement-oracle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const stream = url.searchParams.get("stream");
  const includeEvents = url.searchParams.get("events") === "1";
  const runAuditNow = url.searchParams.get("audit") === "1";

  if (stream === "active") {
    return NextResponse.json({
      stream: "active",
      entries: getActiveOperationsStream(200),
      balance: getActiveOperationsBalance(),
    });
  }
  if (stream === "pipeline") {
    return NextResponse.json({
      stream: "pipeline",
      entries: getPipelineAnalyticsStream(200),
      balance: getPipelineBalance(),
    });
  }
  if (stream === "procurement_active") {
    return NextResponse.json({
      stream: "procurement_active",
      pos: getActivePOs(200),
    });
  }
  if (stream === "procurement_pipeline") {
    return NextResponse.json({
      stream: "procurement_pipeline",
      pos: getPipelinePOs(200),
    });
  }

  // Default: full state.
  const stats = getStats();
  const procurementStats = getProcurementStats();
  const activeOps = getActiveOperationsBalance();
  const pipeline = getPipelineBalance();
  const oracles = listOracleHealth();
  const oracleLog = listOracleCallLog(50);
  const auditFindings = runAuditNow ? runAudit() : runAudit();
  const oracleAudit = auditOracles();
  const tolerances = getTolerances();

  return NextResponse.json({
    stats,
    procurement_stats: procurementStats,
    active_operations_balance: activeOps,
    pipeline_balance: pipeline,
    oracles,
    oracle_call_log: oracleLog,
    audit_findings: auditFindings,
    oracle_audit_findings: oracleAudit,
    tolerances,
    entries_recent: listEntries({ limit: 50 }),
    pos_recent: listPOs({ limit: 50 }),
    events_recent: includeEvents ? listEvents({ limit: 50 }) : undefined,
    hard_rule: {
      active_operations_balance_cents: activeOps.total_cents,
      has_any_receipt: activeOps.has_any_receipt,
      note:
        activeOps.has_any_receipt
          ? "Active Operations balance reflects only cryptographically-settled entries."
          : "HARD RULE: Active Operations balance is $0.00 — no entry carries a receipt_hash. Speculative and Pending_Settlement amounts are segregated in the Pipeline Analytics view.",
    },
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    switch (action) {
      // ── Settlement Ledger actions ────────────────────────────────────
      case "create_entry": {
        const entry = createEntry({
          external_ref: String(body.external_ref || ""),
          kind: (body.kind as "revenue" | "procurement" | "payout") || "revenue",
          amount_cents: Number(body.amount_cents || 0),
          currency: String(body.currency || "USD"),
          counterparty_id: String(body.counterparty_id || ""),
          initiator_agent_id: String(body.initiator_agent_id || ""),
          metadata: (body.metadata as Record<string, unknown>) || {},
        });
        return NextResponse.json({ ok: true, entry });
      }
      case "prepare": {
        const result = prepare(
          String(body.entry_id),
          String(body.initiator_agent_id),
          body.oracle_id as string | undefined
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "commit": {
        const result = commit(
          String(body.entry_id),
          String(body.oracle_id),
          String(body.prepare_token),
          body.receipt_payload
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "fail": {
        const result = fail(
          String(body.entry_id),
          String(body.actor),
          String(body.reason || "")
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "cancel": {
        const result = cancel(
          String(body.entry_id),
          String(body.initiator_agent_id),
          String(body.reason || "")
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "simulate_revenue_webhook": {
        const result = simulateRevenueWebhook(
          String(body.oracle_id || "oracle_stripe"),
          String(body.rail || "stripe"),
          String(body.external_ref),
          Number(body.amount_cents),
          String(body.currency || "USD"),
          String(body.recipient_id),
          (body.status as "succeeded" | "pending" | "failed") || "succeeded"
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      // ── Procurement actions ──────────────────────────────────────────
      case "create_po": {
        const po = createPO({
          supplier_id: String(body.supplier_id || ""),
          procuring_agent_id: String(body.procuring_agent_id || ""),
          line_items: (body.line_items as POLineItem[]) || [],
          currency: (body.currency as string) || "USD",
          metadata: (body.metadata as Record<string, unknown>) || {},
        });
        return NextResponse.json({ ok: true, po });
      }
      case "acknowledge_po": {
        const result = acknowledgePO(
          String(body.po_id),
          (body.supplier_message as Record<string, unknown>) || {}
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "generate_shipment": {
        const result = generateShipment(
          String(body.po_id),
          String(body.carrier),
          String(body.tracking_number)
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "simulate_carrier_scan": {
        const po = getPO(String(body.po_id));
        if (!po) {
          return NextResponse.json(
            { ok: false, reason: `PO ${body.po_id} not found` },
            { status: 400 }
          );
        }
        const result = simulateCarrierPoll(
          String(body.oracle_id || `oracle_${body.carrier}`),
          body.carrier as "fedex" | "ups" | "dhl" | "usps",
          String(body.tracking_number || po.tracking_number || ""),
          String(body.po_id),
          (body.event_type as "picked_up" | "in_transit") || "picked_up"
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "mark_received_verified": {
        const result = markReceivedVerified(
          String(body.po_id),
          body.invoice as Invoice,
          body.receipt as ReceivingReceipt
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "cancel_po": {
        const result = cancelPO(
          String(body.po_id),
          String(body.actor || "operator"),
          String(body.reason || "")
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "fail_po": {
        const result = failPO(
          String(body.po_id),
          String(body.actor || "system"),
          String(body.reason || "")
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "test_three_way_match": {
        const po = getPO(String(body.po_id));
        if (!po) {
          return NextResponse.json(
            { ok: false, reason: `PO ${body.po_id} not found` },
            { status: 400 }
          );
        }
        const match = runThreeWayMatch(
          po,
          body.invoice as Invoice,
          body.receipt as ReceivingReceipt
        );
        return NextResponse.json({ ok: true, match });
      }
      // ── Oracle registry actions ──────────────────────────────────────
      case "register_oracle": {
        const result = registerCustomOracle(
          String(body.id),
          (body.kind as OracleKind) || "settlement",
          String(body.rail)
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "unregister_oracle": {
        const result = unregisterOracle(String(body.id));
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      case "set_oracle_health": {
        const result = setOracleHealthById(
          String(body.id),
          Boolean(body.healthy)
        );
        return NextResponse.json(result, { status: result.ok ? 200 : 400 });
      }
      // ── Tolerances + audit + ingress ────────────────────────────────
      case "set_tolerances": {
        setTolerances(Number(body.amount_pct), Number(body.quantity_pct));
        return NextResponse.json({ ok: true, tolerances: getTolerances() });
      }
      case "run_audit": {
        return NextResponse.json({
          ok: true,
          audit_findings: runAudit(),
          oracle_audit_findings: auditOracles(),
        });
      }
      case "sanitize_ingress": {
        const result = sanitizeIngress(
          (body.payload as Record<string, unknown>) || {}
        );
        return NextResponse.json({ ok: true, ...result });
      }
      case "reset": {
        _resetLedgerForTests();
        _resetProcurementForTests();
        _resetOraclesForTests();
        return NextResponse.json({ ok: true, reset: true });
      }
      default:
        return NextResponse.json(
          { ok: false, error: `unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

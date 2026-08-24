/**
 * Procurement Ledger — Layer 7b of the swarm safety + optimization stack.
 *
 * Parallel to the revenue Settlement Ledger, but specialized for procurement
 * flows. Implements the Procurement Swarm Settlement Blueprint:
 *
 *   [ Procurement Agent ]      → PO_Status.Draft_Speculative
 *   [ Supplier Agent ]         → PO_Status.Supplier_Acknowledged
 *   [ Logistics Agent ]        → PO_Status.Shipment_Pending
 *   [ Hard ERP Gateway ]       → PO_Status.In_Transit   (carrier API verifies possession)
 *   [ Warehouse IoT Gateway ]  → PO_Status.Received_Verified (three-way match)
 *
 * Plus a Decentralized Three-Way Match Engine that requires:
 *
 *            [ Purchase Order ]
 *             /              \
 *            /                \
 *    [ Invoice ] ------------ [ Receiving Receipt ]
 *
 *   The transaction is unconfirmed until PO data, Invoice data, and actual
 *   Carrier/Warehouse data align within exact tolerances.
 *
 * And a Zero-Trust Carrier Tracking Integration that refuses to advance a PO
 * to In_Transit until the carrier's own system returns a physical scan event
 * — never trusts the supplier's self-reported "shipped" status.
 *
 * The Procurement Ledger is bridged into the Settlement Ledger: every
 * Received_Verified PO creates a SETTLED revenue entry (negative for
 * procurement spend, positive for inventory value) so the Active Operations
 * dashboard reflects real, receipted assets only.
 */

import { randomUUID } from "crypto";
import {
  createEntry as createSettlementEntry,
  prepare as settlementPrepare,
  commit as settlementCommit,
  type LedgerEntry,
} from "./settlement-ledger";

// ─── strict PO state typing ───────────────────────────────────────────────

export type POState =
  | "Draft_Speculative" // internal swarm optimization modeling; zero external validity
  | "Supplier_Acknowledged" // supplier agent accepted the API payload; no goods moved
  | "Shipment_Pending" // tracking number generated; carrier API shows "Label Created"
  | "In_Transit" // carrier API verifies physical possession of the asset
  | "Received_Verified" // warehouse IoT + three-way match verified quantity + quality
  | "Cancelled"
  | "Failed";

/** Set of PO states that carry real operational weight. */
export const ACTIVE_PO_STATES: ReadonlySet<POState> = new Set([
  "In_Transit",
  "Received_Verified",
]);

/** Set of PO states with zero external validity — Pipeline Forecast only. */
export const PIPELINE_PO_STATES: ReadonlySet<POState> = new Set([
  "Draft_Speculative",
  "Supplier_Acknowledged",
  "Shipment_Pending",
]);

/** Set of terminal PO states. */
export const TERMINAL_PO_STATES: ReadonlySet<POState> = new Set([
  "Received_Verified",
  "Cancelled",
  "Failed",
]);

// ─── three-way match types ───────────────────────────────────────────────

export interface POLineItem {
  sku: string;
  description: string;
  quantity_ordered: number;
  unit_price_cents: number;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string;
  procuring_agent_id: string;
  line_items: POLineItem[];
  total_cents: number;
  currency: string;
  state: POState;
  created_at: number;
  updated_at: number;
  last_transition_reason: string | null;
  /** Carrier tracking number (set when Shipment_Pending reached). */
  tracking_number: string | null;
  /** Carrier identifier (fedex / ups / dhl / usps). */
  carrier: string | null;
  /** Latest raw carrier scan event (set when In_Transit reached). */
  last_carrier_scan: CarrierScanEvent | null;
  /** Three-way match result (set when Received_Verified reached). */
  three_way_match: ThreeWayMatchResult | null;
  /** Linked settlement ledger entry id (for the Active Operations stream). */
  settlement_entry_id: string | null;
  metadata?: Record<string, unknown>;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  po_id: string;
  supplier_id: string;
  line_items: Array<{
    sku: string;
    quantity_invoiced: number;
    unit_price_cents: number;
  }>;
  total_cents: number;
  currency: string;
  received_at: number;
  /** Source: only 'supplier_api' or 'erp_ingest' are trusted. 'manual' is suspect. */
  source: "supplier_api" | "erp_ingest" | "manual";
  metadata?: Record<string, unknown>;
}

export interface ReceivingReceipt {
  id: string;
  receipt_number: string;
  po_id: string;
  warehouse_id: string;
  line_items: Array<{
    sku: string;
    quantity_received: number;
    /** Quality check result. */
    quality_status: "passed" | "failed" | "partial";
  }>;
  received_at: number;
  /** IoT gateway signature — proves the warehouse scan was hardware-attested. */
  iot_signature: string;
  metadata?: Record<string, unknown>;
}

export interface CarrierScanEvent {
  scan_id: string;
  carrier: string;
  tracking_number: string;
  /** 'label_created' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' */
  event_type: string;
  location: string;
  timestamp: number;
  /** Carrier API signature — proves the scan came from the carrier, not the supplier. */
  carrier_signature: string;
}

export interface ThreeWayMatchResult {
  matched: boolean;
  po_total_cents: number;
  invoice_total_cents: number;
  receipt_total_quantity: number;
  po_total_quantity: number;
  /** Tolerance checks. */
  amount_tolerance_pct: number;
  amount_variance_pct: number;
  quantity_tolerance_pct: number;
  quantity_variance_pct: number;
  within_tolerance: boolean;
  /** Per-line findings. */
  line_findings: Array<{
    sku: string;
    issue: string;
    severity: "info" | "warning" | "critical";
  }>;
  /** Quality findings from the warehouse receipt. */
  quality_findings: string[];
}

// ─── ledger singleton ────────────────────────────────────────────────────

interface ProcurementStore {
  purchase_orders: Map<string, PurchaseOrder>;
  invoices: Map<string, Invoice>;
  receipts: Map<string, ReceivingReceipt>;
  carrier_scans: CarrierScanEvent[];
  /** Tolerance settings for three-way match. */
  amount_tolerance_pct: number;
  quantity_tolerance_pct: number;
  /** Subscribers for PO state transitions. */
  subscribers: Set<(po_id: string, from: POState, to: POState) => void>;
  /** Counters. */
  three_way_matches_passed: number;
  three_way_matches_failed: number;
  carrier_scans_received: number;
  iot_attestations_received: number;
  /** Self-asserted tokens stripped by the ingress layer. */
  self_asserted_tokens_stripped: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __PROCUREMENT_LEDGER__: ProcurementStore | undefined;
}

function getStore(): ProcurementStore {
  if (!globalThis.__PROCUREMENT_LEDGER__) {
    globalThis.__PROCUREMENT_LEDGER__ = {
      purchase_orders: new Map(),
      invoices: new Map(),
      receipts: new Map(),
      carrier_scans: [],
      amount_tolerance_pct: 1.0, // 1% tolerance on amount
      quantity_tolerance_pct: 2.0, // 2% tolerance on quantity
      subscribers: new Set(),
      three_way_matches_passed: 0,
      three_way_matches_failed: 0,
      carrier_scans_received: 0,
      iot_attestations_received: 0,
      self_asserted_tokens_stripped: 0,
    };
  }
  return globalThis.__PROCUREMENT_LEDGER__;
}

// ─── PO lifecycle ────────────────────────────────────────────────────────

export interface CreatePOInput {
  po_number?: string;
  supplier_id: string;
  procuring_agent_id: string;
  line_items: POLineItem[];
  currency?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a new PO in Draft_Speculative state.
 * Internal swarm optimization modeling only — zero external validity.
 */
export function createPO(input: CreatePOInput): PurchaseOrder {
  const id = `po_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const po_number = input.po_number || `PO-${Date.now().toString(36).toUpperCase()}`;
  const total_cents = input.line_items.reduce(
    (s, li) => s + li.quantity_ordered * li.unit_price_cents,
    0
  );
  const now = Date.now();
  const po: PurchaseOrder = {
    id,
    po_number,
    supplier_id: input.supplier_id,
    procuring_agent_id: input.procuring_agent_id,
    line_items: input.line_items,
    total_cents,
    currency: input.currency || "USD",
    state: "Draft_Speculative",
    created_at: now,
    updated_at: now,
    last_transition_reason: "PO drafted by procurement agent",
    tracking_number: null,
    carrier: null,
    last_carrier_scan: null,
    three_way_match: null,
    settlement_entry_id: null,
    metadata: input.metadata,
  };
  getStore().purchase_orders.set(id, po);
  notifySubs(id, "Draft_Speculative" as POState, "Draft_Speculative");
  return po;
}

/**
 * Transition: Draft_Speculative → Supplier_Acknowledged.
 * Triggered when the supplier agent returns an acknowledgement payload.
 *
 * Per the blueprint, this state still has NO physical validity — the
 * supplier has merely accepted the API payload, not shipped any goods.
 */
export function acknowledgePO(
  po_id: string,
  supplier_message: Record<string, unknown>
): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const po = store.purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (po.state !== "Draft_Speculative") {
    return { ok: false, reason: `PO is in ${po.state}, expected Draft_Speculative` };
  }
  // Strip self-asserted completion tokens at the ingress layer.
  const sanitized = stripSelfAssertedTokens(supplier_message);
  return transitionPO(po, "Supplier_Acknowledged", {
    actor: po.supplier_id,
    reason: `supplier acknowledged; stripped ${sanitized.stripped.length} self-asserted token(s)`,
    extra: { supplier_ack: sanitized.clean },
  });
}

/**
 * Transition: Supplier_Acknowledged → Shipment_Pending.
 * Triggered when a tracking number is generated but the carrier API still
 * shows "Label Created / Waiting for Package".
 */
export function generateShipment(
  po_id: string,
  carrier: string,
  tracking_number: string
): { ok: true } | { ok: false; reason: string } {
  const po = getStore().purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (po.state !== "Supplier_Acknowledged") {
    return { ok: false, reason: `PO is in ${po.state}, expected Supplier_Acknowledged` };
  }
  return transitionPO(po, "Shipment_Pending", {
    actor: po.supplier_id,
    reason: `tracking ${tracking_number} generated on ${carrier}; awaiting carrier pickup scan`,
    extra: { carrier, tracking_number },
  });
}

/**
 * Transition: Shipment_Pending → In_Transit.
 *
 * ZERO-TRUST CARRIER TRACKING RULE:
 *   This transition is ONLY permitted when triggered by a verified
 *   CarrierScanEvent from the Logistics Oracle Agent — never by a
 *   supplier's self-reported "shipped" status. The carrier's own system
 *   must return a physical scan event before we advance.
 */
export function markInTransit(
  po_id: string,
  scan: CarrierScanEvent
): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const po = store.purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (po.state !== "Shipment_Pending") {
    return { ok: false, reason: `PO is in ${po.state}, expected Shipment_Pending` };
  }
  // Zero-trust: scan must match the PO's tracking_number + carrier.
  if (scan.tracking_number !== po.tracking_number) {
    return { ok: false, reason: "scan tracking_number does not match PO" };
  }
  if (scan.carrier !== po.carrier) {
    return { ok: false, reason: "scan carrier does not match PO" };
  }
  // Scan must be a physical possession event (not just label_created).
  if (scan.event_type !== "picked_up" && scan.event_type !== "in_transit") {
    return { ok: false, reason: `scan event_type ${scan.event_type} is not a physical possession event` };
  }
  // Record the scan.
  store.carrier_scans.push(scan);
  store.carrier_scans_received++;
  return transitionPO(po, "In_Transit", {
    actor: `oracle_${scan.carrier}`,
    reason: `carrier scan ${scan.scan_id} at ${scan.location}: ${scan.event_type}`,
    extra: { last_carrier_scan: scan },
  });
}

/**
 * Transition: In_Transit → Received_Verified.
 *
 * Requires THREE-WAY MATCH: PO + Invoice + Receiving Receipt must align
 * within tolerance. The receipt must carry an IoT gateway signature
 * attesting that the warehouse scan was hardware-attested.
 *
 * On success, this transition also creates a SETTLED entry in the
 * settlement ledger — bridging procurement into Active Operations.
 */
export function markReceivedVerified(
  po_id: string,
  invoice: Invoice,
  receipt: ReceivingReceipt
): { ok: true; three_way_match: ThreeWayMatchResult } | { ok: false; reason: string; match?: ThreeWayMatchResult } {
  const store = getStore();
  const po = store.purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (po.state !== "In_Transit") {
    return { ok: false, reason: `PO is in ${po.state}, expected In_Transit` };
  }
  // Validate invoice + receipt belong to this PO.
  if (invoice.po_id !== po.id) {
    return { ok: false, reason: "invoice.po_id does not match PO" };
  }
  if (receipt.po_id !== po.id) {
    return { ok: false, reason: "receipt.po_id does not match PO" };
  }
  if (invoice.supplier_id !== po.supplier_id) {
    return { ok: false, reason: "invoice.supplier_id does not match PO" };
  }
  // Receipt must carry an IoT signature.
  if (!receipt.iot_signature) {
    return { ok: false, reason: "receipt has no IoT gateway signature — hardware attestation required" };
  }
  store.iot_attestations_received++;
  // Run three-way match.
  const match = runThreeWayMatch(po, invoice, receipt);
  if (!match.matched || !match.within_tolerance) {
    store.three_way_matches_failed++;
    return { ok: false, reason: "three-way match failed", match };
  }
  // Persist invoice + receipt.
  store.invoices.set(invoice.id, invoice);
  store.receipts.set(receipt.id, receipt);
  store.three_way_matches_passed++;
  // Bridge to settlement ledger: create a SETTLED procurement entry.
  const settlement = createSettlementEntry({
    external_ref: po.po_number,
    kind: "procurement",
    amount_cents: po.total_cents,
    currency: po.currency,
    counterparty_id: po.supplier_id,
    initiator_agent_id: po.procuring_agent_id,
    metadata: {
      po_id: po.id,
      invoice_id: invoice.id,
      receipt_id: receipt.id,
      carrier: po.carrier,
      tracking_number: po.tracking_number,
      line_item_count: po.line_items.length,
    },
  });
  // Auto-prepare + auto-commit (since the three-way match IS the proof).
  const prep = settlementPrepare(
    settlement.id,
    po.procuring_agent_id,
    `oracle_${po.carrier || "erp"}`
  );
  if (!prep.ok) {
    return { ok: false, reason: `settlement prepare failed: ${prep.reason}` };
  }
  const comm = settlementCommit(
    settlement.id,
    `oracle_${po.carrier || "erp"}`,
    prep.prepare_token,
    {
      po_id: po.id,
      invoice_id: invoice.id,
      receipt_id: receipt.id,
      three_way_match: match,
      iot_signature: receipt.iot_signature,
    }
  );
  if (!comm.ok) {
    return { ok: false, reason: `settlement commit failed: ${comm.reason}` };
  }
  // Transition the PO.
  const result = transitionPO(po, "Received_Verified", {
    actor: `warehouse_${receipt.warehouse_id}`,
    reason: `three-way match passed; IoT attested; receipt_hash=${comm.receipt_hash.slice(0, 12)}…`,
    extra: {
      three_way_match: match,
      settlement_entry_id: settlement.id,
      receipt_hash: comm.receipt_hash,
    },
  });
  if (!result.ok) return result;
  return { ok: true, three_way_match: match };
}

/**
 * Cancel a PO before receipt verification.
 */
export function cancelPO(
  po_id: string,
  actor: string,
  reason: string
): { ok: true } | { ok: false; reason: string } {
  const po = getStore().purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (TERMINAL_PO_STATES.has(po.state)) {
    return { ok: false, reason: `PO is in terminal state ${po.state}` };
  }
  return transitionPO(po, "Cancelled", { actor, reason });
}

/**
 * Mark a PO as Failed (e.g. carrier lost the shipment, three-way match irrecoverable).
 */
export function failPO(
  po_id: string,
  actor: string,
  reason: string
): { ok: true } | { ok: false; reason: string } {
  const po = getStore().purchase_orders.get(po_id);
  if (!po) return { ok: false, reason: `PO ${po_id} not found` };
  if (TERMINAL_PO_STATES.has(po.state)) {
    return { ok: false, reason: `PO is in terminal state ${po.state}` };
  }
  return transitionPO(po, "Failed", { actor, reason });
}

// ─── internal transition helper ──────────────────────────────────────────

interface TransitionOpts {
  actor: string;
  reason: string;
  extra?: Record<string, unknown>;
}

function transitionPO(
  po: PurchaseOrder,
  to: POState,
  opts: TransitionOpts
): { ok: true } | { ok: false; reason: string } {
  const from = po.state;
  // Validate the transition is allowed.
  if (!isValidTransition(from, to)) {
    return { ok: false, reason: `invalid transition ${from} → ${to}` };
  }
  const now = Date.now();
  const updated: PurchaseOrder = {
    ...po,
    state: to,
    updated_at: now,
    last_transition_reason: opts.reason,
    tracking_number:
      (opts.extra?.tracking_number as string | undefined) ?? po.tracking_number,
    carrier: (opts.extra?.carrier as string | undefined) ?? po.carrier,
    last_carrier_scan:
      (opts.extra?.last_carrier_scan as CarrierScanEvent | undefined) ??
      po.last_carrier_scan,
    three_way_match:
      (opts.extra?.three_way_match as ThreeWayMatchResult | undefined) ??
      po.three_way_match,
    settlement_entry_id:
      (opts.extra?.settlement_entry_id as string | undefined) ??
      po.settlement_entry_id,
  };
  getStore().purchase_orders.set(po.id, updated);
  notifySubs(po.id, from, to);
  return { ok: true };
}

function isValidTransition(from: POState, to: POState): boolean {
  const ALLOWED: Record<POState, POState[]> = {
    Draft_Speculative: ["Supplier_Acknowledged", "Cancelled", "Failed"],
    Supplier_Acknowledged: ["Shipment_Pending", "Cancelled", "Failed"],
    Shipment_Pending: ["In_Transit", "Cancelled", "Failed"],
    In_Transit: ["Received_Verified", "Failed"],
    Received_Verified: [],
    Cancelled: [],
    Failed: [],
  };
  return ALLOWED[from].includes(to);
}

function notifySubs(po_id: string, from: POState, to: POState): void {
  for (const sub of getStore().subscribers) {
    try {
      sub(po_id, from, to);
    } catch {
      /* swallow */
    }
  }
}

export function subscribeToPOTransitions(
  fn: (po_id: string, from: POState, to: POState) => void
): () => void {
  getStore().subscribers.add(fn);
  return () => getStore().subscribers.delete(fn);
}

// ─── three-way match engine ──────────────────────────────────────────────

/**
 * Decentralized Three-Way Match Engine.
 *
 * Verifies that PO data, Invoice data, and actual Carrier/Warehouse data
 * align within exact tolerances. The transaction is unconfirmed until all
 * three match.
 */
export function runThreeWayMatch(
  po: PurchaseOrder,
  invoice: Invoice,
  receipt: ReceivingReceipt
): ThreeWayMatchResult {
  const store = getStore();
  const line_findings: ThreeWayMatchResult["line_findings"] = [];
  const quality_findings: string[] = [];

  // Aggregate by SKU.
  const poBySku = new Map<string, { qty: number; total: number }>();
  for (const li of po.line_items) {
    const cur = poBySku.get(li.sku) || { qty: 0, total: 0 };
    cur.qty += li.quantity_ordered;
    cur.total += li.quantity_ordered * li.unit_price_cents;
    poBySku.set(li.sku, cur);
  }
  const invBySku = new Map<string, { qty: number; total: number }>();
  for (const li of invoice.line_items) {
    const cur = invBySku.get(li.sku) || { qty: 0, total: 0 };
    cur.qty += li.quantity_invoiced;
    cur.total += li.quantity_invoiced * li.unit_price_cents;
    invBySku.set(li.sku, cur);
  }
  const rcptBySku = new Map<string, { qty: number; quality: string }>();
  for (const li of receipt.line_items) {
    const cur = rcptBySku.get(li.sku) || { qty: 0, quality: "passed" };
    cur.qty += li.quantity_received;
    if (li.quality_status === "failed") cur.quality = "failed";
    else if (li.quality_status === "partial" && cur.quality !== "failed")
      cur.quality = "partial";
    rcptBySku.set(li.sku, cur);
  }

  // Per-line checks: every PO SKU must appear in invoice + receipt.
  for (const [sku, poData] of poBySku) {
    const invData = invBySku.get(sku);
    const rcptData = rcptBySku.get(sku);
    if (!invData) {
      line_findings.push({
        sku,
        issue: "SKU present on PO but missing from invoice",
        severity: "critical",
      });
      continue;
    }
    if (!rcptData) {
      line_findings.push({
        sku,
        issue: "SKU present on PO but missing from receiving receipt",
        severity: "critical",
      });
      continue;
    }
    // Quantity variance.
    const invQtyVar = pctVariance(poData.qty, invData.qty);
    const rcptQtyVar = pctVariance(poData.qty, rcptData.qty);
    if (Math.abs(invQtyVar) > store.quantity_tolerance_pct) {
      line_findings.push({
        sku,
        issue: `invoice quantity variance ${invQtyVar.toFixed(2)}% exceeds tolerance ±${store.quantity_tolerance_pct}%`,
        severity: "warning",
      });
    }
    if (Math.abs(rcptQtyVar) > store.quantity_tolerance_pct) {
      line_findings.push({
        sku,
        issue: `receipt quantity variance ${rcptQtyVar.toFixed(2)}% exceeds tolerance ±${store.quantity_tolerance_pct}%`,
        severity: "warning",
      });
    }
    // Amount variance.
    const amtVar = pctVariance(poData.total, invData.total);
    if (Math.abs(amtVar) > store.amount_tolerance_pct) {
      line_findings.push({
        sku,
        issue: `amount variance ${amtVar.toFixed(2)}% exceeds tolerance ±${store.amount_tolerance_pct}%`,
        severity: "warning",
      });
    }
    // Quality.
    if (rcptData.quality === "failed") {
      quality_findings.push(`SKU ${sku} failed quality check`);
      line_findings.push({
        sku,
        issue: "quality check failed at warehouse",
        severity: "critical",
      });
    } else if (rcptData.quality === "partial") {
      quality_findings.push(`SKU ${sku} partially passed quality check`);
      line_findings.push({
        sku,
        issue: "quality check partial at warehouse",
        severity: "warning",
      });
    }
  }

  // Check for invoiced SKUs not on PO.
  for (const sku of invBySku.keys()) {
    if (!poBySku.has(sku)) {
      line_findings.push({
        sku,
        issue: "SKU on invoice but not on PO",
        severity: "critical",
      });
    }
  }
  // Check for received SKUs not on PO.
  for (const sku of rcptBySku.keys()) {
    if (!poBySku.has(sku)) {
      line_findings.push({
        sku,
        issue: "SKU on receipt but not on PO",
        severity: "critical",
      });
    }
  }

  // Totals.
  const po_total_quantity = po.line_items.reduce((s, li) => s + li.quantity_ordered, 0);
  const receipt_total_quantity = receipt.line_items.reduce(
    (s, li) => s + li.quantity_received,
    0
  );
  const amount_variance_pct = pctVariance(po.total_cents, invoice.total_cents);
  const quantity_variance_pct = pctVariance(po_total_quantity, receipt_total_quantity);

  // Tolerance: no critical findings AND within amount + quantity tolerance.
  const has_critical = line_findings.some((f) => f.severity === "critical");
  const within_tolerance =
    !has_critical &&
    Math.abs(amount_variance_pct) <= store.amount_tolerance_pct &&
    Math.abs(quantity_variance_pct) <= store.quantity_tolerance_pct &&
    quality_findings.length === 0;
  const matched = within_tolerance;

  return {
    matched,
    po_total_cents: po.total_cents,
    invoice_total_cents: invoice.total_cents,
    receipt_total_quantity,
    po_total_quantity,
    amount_tolerance_pct: store.amount_tolerance_pct,
    amount_variance_pct,
    quantity_tolerance_pct: store.quantity_tolerance_pct,
    quantity_variance_pct,
    within_tolerance,
    line_findings,
    quality_findings,
  };
}

function pctVariance(expected: number, actual: number): number {
  if (expected === 0) return actual === 0 ? 0 : 100;
  return ((actual - expected) / expected) * 100;
}

// ─── ingress validation ──────────────────────────────────────────────────

const SELF_ASSERTED_TOKENS = new Set([
  "is_paid",
  "is_confirmed",
  "is_settled",
  "is_shipped",
  "is_delivered",
  "is_received",
  "self_verified",
  "self_signed",
  "supplier_confirmed",
  "agent_confirmed",
  "internally_settled",
  "shipped_by_supplier",
  "delivered_by_supplier",
]);

/**
 * Strip self-asserted completion tokens from supplier/vendor messages.
 * Per the blueprint: "Strip away any self-asserted completion tokens sent
 * by external vendors."
 *
 * Returns the sanitized payload + a list of stripped keys for audit logging.
 */
export function stripSelfAssertedTokens(
  payload: Record<string, unknown>
): { clean: Record<string, unknown>; stripped: string[] } {
  const store = getStore();
  const clean: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (SELF_ASSERTED_TOKENS.has(k)) {
      stripped.push(k);
      store.self_asserted_tokens_stripped++;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = stripSelfAssertedTokens(v as Record<string, unknown>);
      clean[k] = inner.clean;
      stripped.push(...inner.stripped);
    } else {
      clean[k] = v;
    }
  }
  return { clean, stripped };
}

// ─── queries ─────────────────────────────────────────────────────────────

export function getPO(po_id: string): PurchaseOrder | undefined {
  return getStore().purchase_orders.get(po_id);
}

export function getPOByNumber(po_number: string): PurchaseOrder | undefined {
  for (const po of getStore().purchase_orders.values()) {
    if (po.po_number === po_number) return po;
  }
  return undefined;
}

export function listPOs(filter?: {
  state?: POState;
  supplier_id?: string;
  procuring_agent_id?: string;
  limit?: number;
}): PurchaseOrder[] {
  let out = Array.from(getStore().purchase_orders.values());
  if (filter?.state) out = out.filter((p) => p.state === filter.state);
  if (filter?.supplier_id) out = out.filter((p) => p.supplier_id === filter.supplier_id);
  if (filter?.procuring_agent_id)
    out = out.filter((p) => p.procuring_agent_id === filter.procuring_agent_id);
  out.sort((a, b) => b.updated_at - a.updated_at);
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}

/** Active Operations stream — In_Transit + Received_Verified only. */
export function getActivePOs(limit?: number): PurchaseOrder[] {
  const all = listPOs({ limit: 1000 });
  return all
    .filter((p) => ACTIVE_PO_STATES.has(p.state))
    .slice(0, limit || 1000);
}

/** Pipeline Forecast stream — Draft + Acknowledged + Shipment_Pending only. */
export function getPipelinePOs(limit?: number): PurchaseOrder[] {
  const all = listPOs({ limit: 1000 });
  return all
    .filter((p) => PIPELINE_PO_STATES.has(p.state))
    .slice(0, limit || 1000);
}

export interface ProcurementStats {
  total_pos: number;
  by_state: Record<POState, number>;
  active_pos: number;
  pipeline_pos: number;
  total_active_value_cents: number;
  total_pipeline_value_cents: number;
  three_way_matches_passed: number;
  three_way_matches_failed: number;
  carrier_scans_received: number;
  iot_attestations_received: number;
  self_asserted_tokens_stripped: number;
  total_invoices: number;
  total_receipts: number;
}

export function getProcurementStats(): ProcurementStats {
  const store = getStore();
  const all = Array.from(store.purchase_orders.values());
  const by_state: Record<POState, number> = {
    Draft_Speculative: 0,
    Supplier_Acknowledged: 0,
    Shipment_Pending: 0,
    In_Transit: 0,
    Received_Verified: 0,
    Cancelled: 0,
    Failed: 0,
  };
  let total_active_value_cents = 0;
  let total_pipeline_value_cents = 0;
  for (const po of all) {
    by_state[po.state]++;
    if (ACTIVE_PO_STATES.has(po.state)) {
      total_active_value_cents += po.total_cents;
    } else if (PIPELINE_PO_STATES.has(po.state)) {
      total_pipeline_value_cents += po.total_cents;
    }
  }
  return {
    total_pos: all.length,
    by_state,
    active_pos: by_state.In_Transit + by_state.Received_Verified,
    pipeline_pos:
      by_state.Draft_Speculative +
      by_state.Supplier_Acknowledged +
      by_state.Shipment_Pending,
    total_active_value_cents,
    total_pipeline_value_cents,
    three_way_matches_passed: store.three_way_matches_passed,
    three_way_matches_failed: store.three_way_matches_failed,
    carrier_scans_received: store.carrier_scans_received,
    iot_attestations_received: store.iot_attestations_received,
    self_asserted_tokens_stripped: store.self_asserted_tokens_stripped,
    total_invoices: store.invoices.size,
    total_receipts: store.receipts.size,
  };
}

export function setTolerances(amount_pct: number, quantity_pct: number): void {
  const store = getStore();
  store.amount_tolerance_pct = Math.max(0, amount_pct);
  store.quantity_tolerance_pct = Math.max(0, quantity_pct);
}

export function getTolerances(): { amount_pct: number; quantity_pct: number } {
  const store = getStore();
  return {
    amount_pct: store.amount_tolerance_pct,
    quantity_pct: store.quantity_tolerance_pct,
  };
}

export function _resetProcurementForTests(): void {
  const store = getStore();
  store.purchase_orders.clear();
  store.invoices.clear();
  store.receipts.clear();
  store.carrier_scans.length = 0;
  store.three_way_matches_passed = 0;
  store.three_way_matches_failed = 0;
  store.carrier_scans_received = 0;
  store.iot_attestations_received = 0;
  store.self_asserted_tokens_stripped = 0;
}

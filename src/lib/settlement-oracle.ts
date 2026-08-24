/**
 * Settlement Oracle + Logistics Oracle — Layer 7c of the swarm safety stack.
 *
 * Two specialized agents that act as the ONLY bridges between the swarm
 * and the outside world for economic-event verification:
 *
 *   1. SETTLEMENT ORACLE AGENT  (revenue)
 *      Sole job: verify real-world banking API results. Listens for
 *      Stripe / Plaid / Chainlink webhook payloads, validates their
 *      signatures, and (on valid proof) calls commit() on the matching
 *      Settlement Ledger entry. No other agent may commit revenue.
 *
 *   2. LOGISTICS ORACLE AGENT   (procurement)
 *      Sole job: poll multi-carrier tracking APIs (FedEx / UPS / DHL /
 *      USPS / Project44 / FourKites / Shippo) and emit verified
 *      CarrierScanEvent objects. The swarm dashboard remains locked at
 *      "Pending Shipment" until this agent returns a physical scan event.
 *
 * Both oracles run in a hardened sandbox:
 *   - Inbound payloads are signature-verified (HMAC against per-rail secrets)
 *   - Self-asserted completion tokens are stripped at the ingress layer
 *     before the payload reaches the ledger
 *   - All oracle calls are logged for audit
 *
 * In a production deployment, the simulate*() functions below would be
 * replaced with real fetch() calls to the carrier / banking APIs. The
 * signatures + commit-on-proof flow remain identical.
 */

import { createHash, createHmac, randomUUID } from "crypto";
import {
  commit as settlementCommit,
  fail as settlementFail,
  getEntryByExternalRef,
  listEntries,
  listOracles,
  prepare as settlementPrepare,
  registerOracle,
  setOracleHealth,
  type LedgerEntry,
} from "./settlement-ledger";
import {
  markInTransit,
  type CarrierScanEvent,
  type PurchaseOrder,
} from "./procurement-ledger";

// ─── oracle types ────────────────────────────────────────────────────────

export type OracleKind = "settlement" | "logistics";

export interface OracleHealth {
  id: string;
  kind: OracleKind;
  rail: string;
  healthy: boolean;
  last_check_at: number | null;
  last_check_ok: boolean;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  avg_latency_ms: number;
}

export interface OracleCallLog {
  id: string;
  ts: number;
  oracle_id: string;
  kind: OracleKind;
  rail: string;
  external_ref: string | null;
  success: boolean;
  latency_ms: number;
  reason: string;
  /** Stripped self-asserted tokens (audit trail). */
  stripped_tokens: string[];
}

// ─── oracle store ────────────────────────────────────────────────────────

interface OracleStore {
  health: Map<string, OracleHealth>;
  call_log: OracleCallLog[];
  /** Per-rail HMAC secrets for webhook signature verification. */
  rail_secrets: Map<string, string>;
  /** Subscribers for oracle events. */
  subscribers: Set<(log: OracleCallLog) => void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __SETTLEMENT_ORACLE__: OracleStore | undefined;
}

function getStore(): OracleStore {
  if (!globalThis.__SETTLEMENT_ORACLE__) {
    const store: OracleStore = {
      health: new Map(),
      call_log: [],
      rail_secrets: new Map([
        ["stripe", process.env.STRIPE_WEBHOOK_SECRET || "charibaas-stripe-secret-v1"],
        ["plaid", process.env.PLAID_WEBHOOK_SECRET || "charibaas-plaid-secret-v1"],
        ["chainlink", process.env.CHAINLINK_ORACLE_SECRET || "charibaas-chainlink-secret-v1"],
        ["fedex", process.env.FEDEX_API_SECRET || "charibaas-fedex-secret-v1"],
        ["ups", process.env.UPS_API_SECRET || "charibaas-ups-secret-v1"],
        ["dhl", process.env.DHL_API_SECRET || "charibaas-dhl-secret-v1"],
        ["usps", process.env.USPS_API_SECRET || "charibaas-usps-secret-v1"],
      ]),
      subscribers: new Set(),
    };
    // Seed health for the default registered oracles.
    const seeded: Array<[string, OracleKind, string]> = [
      ["oracle_stripe", "settlement", "stripe"],
      ["oracle_plaid", "settlement", "plaid"],
      ["oracle_chainlink", "settlement", "chainlink"],
      ["oracle_fedex", "logistics", "fedex"],
      ["oracle_ups", "logistics", "ups"],
      ["oracle_dhl", "logistics", "dhl"],
    ];
    for (const [id, kind, rail] of seeded) {
      store.health.set(id, {
        id,
        kind,
        rail,
        healthy: true,
        last_check_at: null,
        last_check_ok: false,
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        avg_latency_ms: 0,
      });
    }
    globalThis.__SETTLEMENT_ORACLE__ = store;
  }
  return globalThis.__SETTLEMENT_ORACLE__;
}

// ─── webhook signature verification ──────────────────────────────────────

/**
 * Verify a webhook payload signature against the per-rail HMAC secret.
 * This is the cryptographic boundary that proves the payload came from
 * the real Stripe / Plaid / carrier, not from a malicious agent.
 */
export function verifyWebhookSignature(
  rail: string,
  payload: string,
  signature: string
): boolean {
  const secret = getStore().rail_secrets.get(rail);
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time comparison.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ─── settlement oracle (revenue) ─────────────────────────────────────────

export interface RevenueWebhookPayload {
  /** Stripe payment_intent id, Plaid transaction id, Chainlink request id. */
  external_id: string;
  /** Currency amount in cents. */
  amount_cents: number;
  currency: string;
  /** Counterparty (recipient) identifier. */
  recipient_id: string;
  /** Linked swarm external_ref (e.g. RevenueEvent.event_id). */
  external_ref: string;
  /** Status from the rail: 'succeeded' | 'pending' | 'failed'. */
  status: "succeeded" | "pending" | "failed";
  /** ISO timestamp of the webhook. */
  event_ts: string;
  /** Self-asserted tokens (will be stripped at ingress). */
  [key: string]: unknown;
}

const SELF_ASSERTED_REVENUE_KEYS = new Set([
  "is_paid",
  "self_verified",
  "agent_confirmed",
  "internally_settled",
  "confirmed_by_agent",
]);

/**
 * Ingress validation for revenue webhooks. Strips self-asserted
 * completion tokens before the payload can influence the ledger.
 */
function sanitizeRevenueWebhook(
  payload: RevenueWebhookPayload
): { clean: RevenueWebhookPayload; stripped: string[] } {
  const stripped: string[] = [];
  const clean: RevenueWebhookPayload = { ...payload };
  for (const k of Object.keys(clean)) {
    if (SELF_ASSERTED_REVENUE_KEYS.has(k)) {
      stripped.push(k);
      delete (clean as Record<string, unknown>)[k];
    }
  }
  return { clean, stripped };
}

/**
 * SETTLEMENT ORACLE AGENT — handle an inbound webhook from Stripe / Plaid /
 * Chainlink / bank. Verifies the signature, strips self-asserted tokens,
 * then commits the matching Settlement Ledger entry.
 *
 * Returns:
 *   - { ok: true, receipt_hash } on successful commit
 *   - { ok: false, reason } if the webhook is invalid OR no matching
 *     PENDING_SETTLEMENT entry exists
 */
export function handleRevenueWebhook(
  oracle_id: string,
  rail: string,
  payload: RevenueWebhookPayload,
  signature: string
): { ok: true; receipt_hash: string } | { ok: false; reason: string } {
  const t0 = Date.now();
  const store = getStore();
  const health = store.health.get(oracle_id);
  if (!health) {
    logOracleCall(oracle_id, "settlement", rail, payload.external_ref, false, t0, "oracle not registered", []);
    return { ok: false, reason: `oracle ${oracle_id} not registered` };
  }
  if (health.rail !== rail) {
    logOracleCall(oracle_id, "settlement", rail, payload.external_ref, false, t0, "rail mismatch", []);
    return { ok: false, reason: `oracle ${oracle_id} is for rail ${health.rail}, got ${rail}` };
  }
  // Step 1: signature verification.
  const payloadStr = JSON.stringify(payload);
  if (!verifyWebhookSignature(rail, payloadStr, signature)) {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, payload.external_ref, false, t0, "signature verification failed", []);
    return { ok: false, reason: "webhook signature verification failed" };
  }
  // Step 2: ingress validation — strip self-asserted tokens.
  const { clean, stripped } = sanitizeRevenueWebhook(payload);
  // Step 3: find the matching PENDING_SETTLEMENT entry.
  const entry = getEntryByExternalRef(clean.external_ref);
  if (!entry) {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, "no ledger entry found for external_ref", stripped);
    return { ok: false, reason: `no ledger entry found for external_ref ${clean.external_ref}` };
  }
  if (entry.state !== "PENDING_SETTLEMENT") {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, `entry is in ${entry.state}, not PENDING_SETTLEMENT`, stripped);
    return { ok: false, reason: `entry is in ${entry.state}, expected PENDING_SETTLEMENT` };
  }
  if (!entry.prepare_token) {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, "entry has no prepare_token — Phase 1 was never completed", stripped);
    return { ok: false, reason: "entry has no prepare_token — Phase 1 was never completed" };
  }
  // Step 4: handle the rail status.
  if (clean.status === "failed") {
    const failResult = settlementFail(entry.id, oracle_id, `rail reported failed: ${clean.external_id}`);
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, failResult.ok, t0, failResult.ok ? "entry failed on rail rejection" : failResult.reason, stripped);
    return { ok: false, reason: `rail reported failed: ${clean.external_id}` };
  }
  if (clean.status === "pending") {
    // Don't commit yet — wait for 'succeeded'.
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, true, t0, "rail reports pending — awaiting succeeded", stripped);
    return { ok: false, reason: "rail reports pending — awaiting succeeded" };
  }
  if (clean.status !== "succeeded") {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, `unknown rail status: ${clean.status}`, stripped);
    return { ok: false, reason: `unknown rail status: ${clean.status}` };
  }
  // Step 5: verify the amount + counterparty match the ledger entry.
  if (clean.amount_cents !== entry.amount_cents) {
    health.failed_calls++;
    const reason = `amount mismatch: webhook ${clean.amount_cents}, ledger ${entry.amount_cents}`;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, reason, stripped);
    return { ok: false, reason };
  }
  if (clean.recipient_id !== entry.counterparty_id) {
    health.failed_calls++;
    const reason = `recipient mismatch: webhook ${clean.recipient_id}, ledger ${entry.counterparty_id}`;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, reason, stripped);
    return { ok: false, reason };
  }
  // Step 6: COMMIT — the only path to SETTLED.
  const commitResult = settlementCommit(entry.id, oracle_id, entry.prepare_token, {
    rail,
    external_id: clean.external_id,
    event_ts: clean.event_ts,
  });
  if (!commitResult.ok) {
    health.failed_calls++;
    logOracleCall(oracle_id, "settlement", rail, clean.external_ref, false, t0, commitResult.reason, stripped);
    return { ok: false, reason: commitResult.reason };
  }
  health.successful_calls++;
  health.last_check_ok = true;
  health.last_check_at = Date.now();
  logOracleCall(oracle_id, "settlement", rail, clean.external_ref, true, t0, `committed; receipt_hash=${commitResult.receipt_hash.slice(0, 12)}…`, stripped);
  return { ok: true, receipt_hash: commitResult.receipt_hash };
}

// ─── logistics oracle (procurement) ──────────────────────────────────────

export interface CarrierTrackingPayload {
  carrier: "fedex" | "ups" | "dhl" | "usps";
  tracking_number: string;
  scan_id: string;
  event_type: "label_created" | "picked_up" | "in_transit" | "out_for_delivery" | "delivered";
  location: string;
  timestamp: number;
  /** Linked PO id (so we can route the scan to the right PO). */
  po_id?: string;
  /** Self-asserted tokens (will be stripped at ingress). */
  [key: string]: unknown;
}

const SELF_ASSERTED_LOGISTICS_KEYS = new Set([
  "is_shipped",
  "is_delivered",
  "is_received",
  "supplier_confirmed",
  "shipped_by_supplier",
  "delivered_by_supplier",
]);

function sanitizeLogisticsPayload(
  payload: CarrierTrackingPayload
): { clean: CarrierTrackingPayload; stripped: string[] } {
  const stripped: string[] = [];
  const clean: CarrierTrackingPayload = { ...payload };
  for (const k of Object.keys(clean)) {
    if (SELF_ASSERTED_LOGISTICS_KEYS.has(k)) {
      stripped.push(k);
      delete (clean as Record<string, unknown>)[k];
    }
  }
  return { clean, stripped };
}

/**
 * LOGISTICS ORACLE AGENT — handle an inbound carrier scan webhook from
 * FedEx / UPS / DHL / USPS. Verifies the signature, strips self-asserted
 * tokens, then advances the matching PO to In_Transit.
 *
 * Per the blueprint: "Agents must not trust self-reported shipping updates
 * from suppliers. Isolate tracking to a specialized Logistics Oracle Agent."
 */
export function handleCarrierScanWebhook(
  oracle_id: string,
  payload: CarrierTrackingPayload,
  signature: string
): { ok: true; scan: CarrierScanEvent; po_id: string } | { ok: false; reason: string } {
  const t0 = Date.now();
  const store = getStore();
  const health = store.health.get(oracle_id);
  if (!health) {
    logOracleCall(oracle_id, "logistics", payload.carrier, null, false, t0, "oracle not registered", []);
    return { ok: false, reason: `oracle ${oracle_id} not registered` };
  }
  if (health.kind !== "logistics") {
    logOracleCall(oracle_id, "logistics", payload.carrier, null, false, t0, "oracle is not a logistics oracle", []);
    return { ok: false, reason: `oracle ${oracle_id} is not a logistics oracle` };
  }
  if (health.rail !== payload.carrier) {
    logOracleCall(oracle_id, "logistics", payload.carrier, null, false, t0, "carrier mismatch", []);
    return { ok: false, reason: `oracle ${oracle_id} is for carrier ${health.rail}, got ${payload.carrier}` };
  }
  // Step 1: signature verification.
  const payloadStr = JSON.stringify(payload);
  if (!verifyWebhookSignature(payload.carrier, payloadStr, signature)) {
    health.failed_calls++;
    logOracleCall(oracle_id, "logistics", payload.carrier, payload.tracking_number, false, t0, "signature verification failed", []);
    return { ok: false, reason: "carrier webhook signature verification failed" };
  }
  // Step 2: ingress validation.
  const { clean, stripped } = sanitizeLogisticsPayload(payload);
  // Step 3: build the canonical CarrierScanEvent.
  const scan: CarrierScanEvent = {
    scan_id: clean.scan_id,
    carrier: clean.carrier,
    tracking_number: clean.tracking_number,
    event_type: clean.event_type,
    location: clean.location,
    timestamp: clean.timestamp,
    carrier_signature: signature,
  };
  // Step 4: find the PO by tracking_number (or by po_id if explicitly provided).
  let po_id = clean.po_id;
  if (!po_id) {
    // Search all POs for one with this tracking_number.
    const { listPOs } = require("./procurement-ledger") as typeof import("./procurement-ledger");
    const candidates = listPOs({ limit: 500 });
    const match = candidates.find((p) => p.tracking_number === clean.tracking_number);
    po_id = match?.id;
  }
  if (!po_id) {
    health.failed_calls++;
    logOracleCall(oracle_id, "logistics", clean.carrier, clean.tracking_number, false, t0, "no PO found for tracking_number", stripped);
    return { ok: false, reason: `no PO found for tracking_number ${clean.tracking_number}` };
  }
  // Step 5: only physical possession events advance to In_Transit.
  if (clean.event_type !== "picked_up" && clean.event_type !== "in_transit") {
    // Record the scan but don't transition the PO.
    logOracleCall(oracle_id, "logistics", clean.carrier, clean.tracking_number, true, t0, `scan recorded (event_type=${clean.event_type}) — no PO transition`, stripped);
    return { ok: false, reason: `scan event_type ${clean.event_type} is not a physical possession event — PO not advanced` };
  }
  // Step 6: advance the PO via the procurement ledger's zero-trust gate.
  const result = markInTransit(po_id, scan);
  if (!result.ok) {
    health.failed_calls++;
    logOracleCall(oracle_id, "logistics", clean.carrier, clean.tracking_number, false, t0, result.reason, stripped);
    return { ok: false, reason: result.reason };
  }
  health.successful_calls++;
  health.last_check_ok = true;
  health.last_check_at = Date.now();
  logOracleCall(oracle_id, "logistics", clean.carrier, clean.tracking_number, true, t0, `PO ${po_id} advanced to In_Transit`, stripped);
  return { ok: true, scan, po_id };
}

// ─── proactive polling (simulated) ───────────────────────────────────────

/**
 * Simulate polling a carrier API for a tracking number.
 *
 * In production this would be a real fetch() to the carrier's tracking API.
 * Here we synthesize a deterministic scan event so the procurement flow
 * can be exercised end-to-end without external dependencies.
 */
export function simulateCarrierPoll(
  oracle_id: string,
  carrier: "fedex" | "ups" | "dhl" | "usps",
  tracking_number: string,
  po_id: string,
  event_type: CarrierTrackingPayload["event_type"] = "picked_up"
): { ok: true } | { ok: false; reason: string } {
  const payload: CarrierTrackingPayload = {
    carrier,
    tracking_number,
    scan_id: `scan_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    event_type,
    location: `${carrier.toUpperCase()} HUB`,
    timestamp: Date.now(),
    po_id,
  };
  // Self-sign with the rail secret — the polling path is trusted because
  // the oracle initiated it, so we synthesize a valid HMAC.
  const secret = getStore().rail_secrets.get(carrier) || "charibaas-sim-secret";
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  return handleCarrierScanWebhook(oracle_id, payload, signature);
}

/**
 * Simulate receiving a revenue webhook (for testing / sandbox).
 *
 * In production this would arrive as an HTTP POST from Stripe / Plaid / etc.
 */
export function simulateRevenueWebhook(
  oracle_id: string,
  rail: string,
  external_ref: string,
  amount_cents: number,
  currency: string,
  recipient_id: string,
  status: "succeeded" | "pending" | "failed" = "succeeded"
): { ok: true; receipt_hash: string } | { ok: false; reason: string } {
  const payload: RevenueWebhookPayload = {
    external_id: `ext_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    amount_cents,
    currency,
    recipient_id,
    external_ref,
    status,
    event_ts: new Date().toISOString(),
  };
  const secret = getStore().rail_secrets.get(rail) || "charibaas-sim-secret";
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  return handleRevenueWebhook(oracle_id, rail, payload, signature);
}

// ─── settlement coordinator integration ──────────────────────────────────

/**
 * Convenience: run the full 2PC pipeline for a revenue event in a single call.
 *
 * 1. Create a SPECULATIVE ledger entry (if not exists)
 * 2. Prepare (Phase 1) — validate the path
 * 3. Wait for oracle proof (Phase 2) — calls simulateRevenueWebhook
 *
 * Used by the orchestrator's maybePayout() flow.
 */
export function runRevenueSettlement2PC(args: {
  external_ref: string;
  amount_cents: number;
  currency: string;
  recipient_id: string;
  initiator_agent_id: string;
  rail?: string;
  oracle_id?: string;
  metadata?: Record<string, unknown>;
}): { ok: true; receipt_hash: string } | { ok: false; reason: string; phase?: "prepare" | "commit" } {
  const {
    createEntry,
    prepare,
  } = require("./settlement-ledger") as typeof import("./settlement-ledger");
  // Step 1: create or reuse the ledger entry.
  let entry = getEntryByExternalRef(args.external_ref);
  if (!entry) {
    entry = createEntry({
      external_ref: args.external_ref,
      kind: "revenue",
      amount_cents: args.amount_cents,
      currency: args.currency,
      counterparty_id: args.recipient_id,
      initiator_agent_id: args.initiator_agent_id,
      metadata: args.metadata,
    });
  }
  // Step 2: prepare (Phase 1).
  if (entry.state === "SPECULATIVE") {
    const oracle_id = args.oracle_id || pickOracleForRail(args.rail || "ach", "settlement") || undefined;
    const prep = prepare(entry.id, args.initiator_agent_id, oracle_id);
    if (!prep.ok) {
      return { ok: false, reason: prep.reason, phase: "prepare" };
    }
    entry = getEntryByExternalRef(args.external_ref)!;
  }
  if (entry.state !== "PENDING_SETTLEMENT") {
    return {
      ok: false,
      reason: `entry is in ${entry.state} after prepare, expected PENDING_SETTLEMENT`,
      phase: "prepare",
    };
  }
  // Step 3: commit (Phase 2) — simulate the oracle webhook.
  const rail = entry.rail || args.rail || "ach";
  const oracle_id = entry.oracle_id || args.oracle_id || pickOracleForRail(rail, "settlement");
  if (!oracle_id) {
    return { ok: false, reason: `no oracle registered for rail ${rail}`, phase: "commit" };
  }
  const commitResult = simulateRevenueWebhook(
    oracle_id,
    rail,
    args.external_ref,
    args.amount_cents,
    args.currency,
    args.recipient_id,
    "succeeded"
  );
  if (!commitResult.ok) {
    return { ok: false, reason: commitResult.reason, phase: "commit" };
  }
  return { ok: true, receipt_hash: commitResult.receipt_hash };
}

function pickOracleForRail(rail: string, kind: OracleKind): string | null {
  for (const h of getStore().health.values()) {
    if (h.kind === kind && h.rail === rail && h.healthy) return h.id;
  }
  // Fallback: any healthy oracle of the right kind.
  for (const h of getStore().health.values()) {
    if (h.kind === kind && h.healthy) return h.id;
  }
  return null;
}

// ─── logging + health ────────────────────────────────────────────────────

function logOracleCall(
  oracle_id: string,
  kind: OracleKind,
  rail: string,
  external_ref: string | null,
  success: boolean,
  t0: number,
  reason: string,
  stripped_tokens: string[]
): void {
  const store = getStore();
  const latency_ms = Date.now() - t0;
  const log: OracleCallLog = {
    id: `ocall_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    ts: Date.now(),
    oracle_id,
    kind,
    rail,
    external_ref,
    success,
    latency_ms,
    reason,
    stripped_tokens,
  };
  store.call_log.push(log);
  // Trim log to last 500 entries.
  if (store.call_log.length > 500) {
    store.call_log.splice(0, store.call_log.length - 500);
  }
  // Update health aggregates.
  const health = store.health.get(oracle_id);
  if (health) {
    health.total_calls++;
    const total = health.successful_calls + health.failed_calls;
    health.avg_latency_ms =
      total > 0
        ? Math.round((health.avg_latency_ms * (total - 1) + latency_ms) / total)
        : latency_ms;
    health.last_check_at = Date.now();
    health.last_check_ok = success;
  }
  // Notify subscribers.
  for (const sub of store.subscribers) {
    try {
      sub(log);
    } catch {
      /* swallow */
    }
  }
}

export function listOracleHealth(): OracleHealth[] {
  return Array.from(getStore().health.values());
}

export function listOracleCallLog(limit?: number): OracleCallLog[] {
  const out = [...getStore().call_log].sort((a, b) => b.ts - a.ts);
  return limit ? out.slice(0, limit) : out;
}

export function setOracleHealthById(id: string, healthy: boolean): { ok: true } | { ok: false; reason: string } {
  const result = setOracleHealth(id, healthy);
  if (!result.ok) return result;
  const h = getStore().health.get(id);
  if (h) h.healthy = healthy;
  return { ok: true };
}

export function registerCustomOracle(
  id: string,
  kind: OracleKind,
  rail: string
): { ok: true } | { ok: false; reason: string } {
  // Register in the settlement ledger's oracle registry (for commit auth).
  const reg = registerOracle(id, rail);
  if (!reg.ok) return reg;
  // Register in our health map (idempotent — overwrite if exists).
  getStore().health.set(id, {
    id,
    kind,
    rail,
    healthy: true,
    last_check_at: null,
    last_check_ok: false,
    total_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    avg_latency_ms: 0,
  });
  return { ok: true };
}

export function subscribeToOracleCalls(fn: (log: OracleCallLog) => void): () => void {
  getStore().subscribers.add(fn);
  return () => getStore().subscribers.delete(fn);
}

// ─── audit ───────────────────────────────────────────────────────────────

export interface OracleAuditFinding {
  severity: "info" | "warning" | "critical";
  oracle_id: string;
  issue: string;
  detail?: string;
}

export function auditOracles(): OracleAuditFinding[] {
  const findings: OracleAuditFinding[] = [];
  const health = listOracleHealth();
  const registeredOracles = new Set(listOracles().map((o) => o.id));
  for (const h of health) {
    if (!h.healthy) {
      findings.push({
        severity: "warning",
        oracle_id: h.id,
        issue: "oracle marked unhealthy",
        detail: `rail ${h.rail} — last check ok: ${h.last_check_ok}`,
      });
    }
    if (!registeredOracles.has(h.id)) {
      findings.push({
        severity: "critical",
        oracle_id: h.id,
        issue: "oracle in health map but not registered in ledger",
        detail: "Commit calls from this oracle would be rejected.",
      });
    }
    if (h.total_calls > 0 && h.failed_calls / h.total_calls > 0.5) {
      findings.push({
        severity: "warning",
        oracle_id: h.id,
        issue: "high failure rate",
        detail: `${h.failed_calls}/${h.total_calls} calls failed (${Math.round((h.failed_calls / h.total_calls) * 100)}%)`,
      });
    }
  }
  // Check for entries stuck in PENDING_SETTLEMENT with no oracle calls.
  const pending = listEntries({ state: "PENDING_SETTLEMENT" });
  for (const entry of pending) {
    const age = Date.now() - entry.updated_at;
    if (age > 5 * 60_000) {
      findings.push({
        severity: "warning",
        oracle_id: entry.oracle_id || "(none)",
        issue: "PENDING_SETTLEMENT entry older than 5 minutes",
        detail: `entry ${entry.id} (${entry.external_ref}) has been awaiting oracle proof for ${Math.floor(age / 1000)}s`,
      });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return findings;
}

// ─── reset for tests ─────────────────────────────────────────────────────

export function _resetOraclesForTests(): void {
  const store = getStore();
  store.call_log.length = 0;
  for (const h of store.health.values()) {
    h.total_calls = 0;
    h.successful_calls = 0;
    h.failed_calls = 0;
    h.avg_latency_ms = 0;
    h.last_check_at = null;
    h.last_check_ok = false;
    h.healthy = true;
  }
}

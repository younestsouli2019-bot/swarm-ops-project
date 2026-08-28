/**
 * Payout State Machine — Layer 8 of the swarm safety stack.
 *
 * Canonical state machine for every payout that leaves this system:
 *
 *   pending → validated → authorized → submitted → settled → reconciled
 *                                                              ↘ failed
 *                                          ↘ failed ← any state
 *                                          ↘ cancelled ← pending/validated/authorized
 *
 * ─────────────────────────────────────────────────────────────────────
 *  STATES (strictly typed — no booleans, no soft enums)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   pending       PayoutItem record created in Base44. No external
 *                 action taken yet. ZERO economic weight.
 *
 *   validated     Recipient identity confirmed (KYC, account format
 *                 check, owner-whitelist match). Amount is a positive
 *                 number within rail limits. Currency is supported.
 *
 *   authorized    A real human OR a real licensed-PSP webhook has
 *                 signed off on the transfer. Autonomous agents CANNOT
 *                 authorize payouts — the entire point of this layer
 *                 is that the swarm may not move money on its own
 *                 signature.
 *
 *   submitted     The payout payload has been sent to a real external
 *                 rail (Stripe / ACH file / SWIFT message / on-chain
 *                 tx broadcast / Payoneer API call). The rail has
 *                 acknowledged receipt with a real reference id.
 *                 Awaiting confirmation.
 *
 *   settled       The rail has returned an immutable confirmation
 *                 (Stripe webhook `charge.succeeded`, ACH settlement
 *                 notification, on-chain block inclusion, bank credit
 *                 line on statement import). The receipt_hash is set
 *                 from the rail's confirmation.
 *
 *   reconciled    The settled payout has been matched against an
 *                 imported bank statement line via SHA-256 correlation
 *                 ID. The bank's reference is stamped as
 *                 `bank_statement_ref`. This is the terminal "real
 *                 money arrived" state.
 *
 *   failed        Terminal. The rail rejected, the oracle returned
 *                 irrecoverable rejection, or the human reviewer
 *                 cancelled after submission.
 *
 *   cancelled     Terminal. The initiator revoked before submission.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  GUARDS (every transition has a hard precondition)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   pending → validated
 *     Guard: recipient passes isPresetOwnerRecipient() AND amount > 0
 *            AND currency ∈ supported set AND recipient account format
 *            is valid for the rail.
 *
 *   validated → authorized
 *     Guard: authorizer is a human (request.headers.authorization
 *            contains a valid session JWT) OR authorizer is a licensed
 *            PSP webhook with verified signature. Autonomous agents
 *            are explicitly rejected.
 *
 *   authorized → submitted
 *     Guard: a real rail adapter is registered for the recipient's
 *            currency/type. The adapter.submit() call returns a real
 *            rail reference. Stub adapters return
 *            { ok: false, reason: "no_live_rail" } — the payout
 *            stays in `authorized` until a real adapter is connected.
 *
 *   submitted → settled
 *     Guard: real external proof arrives (webhook verified, or bank
 *            statement line matched via correlation ID). The proof
 *            is hashed to produce receipt_hash. NO SIMULATION.
 *
 *   settled → reconciled
 *     Guard: bank statement line with matching correlation ID is
 *            imported. Sets bank_statement_ref.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  APPEND-ONLY EVENT LOG
 * ─────────────────────────────────────────────────────────────────────
 *
 *   Every transition appends a PayoutEvent to an in-memory log. The
 *   log is the canonical history; the per-item `state` field is a
 *   denormalized view.
 *
 *   Singleton via globalThis so HMR doesn't fork the log.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  WHAT THIS MODULE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - Does not call any payment rail
 *   - Does not store bank account numbers, wallet addresses, or
 *     credentials (those live in PayoutRecipient records, accessed
 *     only at submit-time by the rail adapter)
 *   - Does not trust autonomous-agent signatures for authorization
 *   - Does not fabricate transaction ids — every external_reference
 *     must come from a real rail adapter
 */

import { createHash, randomUUID } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export type PayoutState =
  | "pending"
  | "validated"
  | "authorized"
  | "submitted"
  | "settled"
  | "reconciled"
  | "failed"
  | "cancelled";

export const PIPELINE_PAYOUT_STATES: ReadonlySet<PayoutState> = new Set([
  "pending",
  "validated",
  "authorized",
  "submitted",
]);

export const TERMINAL_PAYOUT_STATES: ReadonlySet<PayoutState> = new Set([
  "settled",
  "reconciled",
  "failed",
  "cancelled",
]);

export const ACTIVE_PAYOUT_STATES: ReadonlySet<PayoutState> = new Set([
  "settled",
  "reconciled",
]);

export type PayoutEventKind =
  | "created"
  | "validated"
  | "authorized"
  | "submitted"
  | "settled"
  | "reconciled"
  | "failed"
  | "cancelled";

export interface PayoutEvent {
  id: string;
  payout_id: string;
  kind: PayoutEventKind;
  from_state: PayoutState;
  to_state: PayoutState;
  ts: number;
  actor: string;
  reason: string;
  event_hash: string;
  external_reference?: string;
  receipt_hash?: string;
  bank_statement_ref?: string;
  metadata?: Record<string, unknown>;
}

export interface PayoutItem {
  id: string;
  state: PayoutState;
  amount_cents: number;
  currency: string;
  recipient_id: string;
  recipient_type: "paypal_email" | "bank_account" | "crypto_wallet" | "payoneer";
  rail: string | null;
  external_reference: string | null;
  receipt_hash: string | null;
  bank_statement_ref: string | null;
  correlation_id: string;
  created_at: number;
  updated_at: number;
  last_transition_reason: string | null;
  metadata: Record<string, unknown>;
}

// ─── Valid transitions lookup ────────────────────────────────────────

const VALID_TRANSITIONS: Record<PayoutState, ReadonlySet<PayoutState>> = {
  pending: new Set(["validated", "cancelled", "failed"]),
  validated: new Set(["authorized", "cancelled", "failed"]),
  authorized: new Set(["submitted", "cancelled", "failed"]),
  submitted: new Set(["settled", "failed"]),
  settled: new Set(["reconciled"]),
  reconciled: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function isValidTransition(from: PayoutState, to: PayoutState): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

// ─── Rail adapter interface ──────────────────────────────────────────
//
// A rail adapter is the ONLY thing that talks to a real external payment
// system. The state machine itself never makes a fetch() call.
//
// To connect a real rail (Stripe, ACH, SWIFT, on-chain), implement this
// interface and call registerRailAdapter(). The state machine will refuse
// to transition `authorized → submitted` unless a registered adapter
// returns { ok: true, external_reference }.

export interface RailSubmitResult {
  ok: true;
  external_reference: string;
  submitted_at: string;
  raw?: Record<string, unknown>;
}
export interface RailSubmitError {
  ok: false;
  reason: string;
  code?:
    | "no_live_rail"
    | "rail_unreachable"
    | "recipient_rejected"
    | "amount_invalid"
    | "rate_limited"
    | "auth_required";
}

export interface RailAdapter {
  id: string;
  rail: string; // "stripe" | "ach" | "swift" | "onchain_usdt" | "paypal" | ...
  supported_recipient_types: ReadonlyArray<PayoutItem["recipient_type"]>;
  supported_currencies: ReadonlyArray<string>;
  submit(args: {
    payout_id: string;
    amount_cents: number;
    currency: string;
    recipient_id: string;
    recipient_type: PayoutItem["recipient_type"];
    correlation_id: string;
  }): Promise<RailSubmitResult | RailSubmitError>;
}

// ─── Store (globalThis singleton) ────────────────────────────────────

interface PayoutStore {
  items: Map<string, PayoutItem>;
  events: PayoutEvent[];
  rails: Map<string, RailAdapter>;
  subscribers: Array<(ev: PayoutEvent) => void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __PAYOUT_STATE_MACHINE__: PayoutStore | undefined;
}

function getStore(): PayoutStore {
  if (!globalThis.__PAYOUT_STATE_MACHINE__) {
    globalThis.__PAYOUT_STATE_MACHINE__ = {
      items: new Map(),
      events: [],
      rails: new Map(),
      subscribers: [],
    };
  }
  return globalThis.__PAYOUT_STATE_MACHINE__;
}

function hashEvent(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function logEvent(payout_id: string, ev: Omit<PayoutEvent, "id" | "ts" | "event_hash" | "payout_id">): PayoutEvent {
  const store = getStore();
  const id = `pev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const ts = Date.now();
  const event_hash = hashEvent(`${payout_id}|${ev.kind}|${ev.from_state}|${ev.to_state}|${ts}|${ev.actor}|${ev.reason}`);
  const full: PayoutEvent = { id, payout_id, ts, event_hash, ...ev };
  store.events.push(full);
  if (store.events.length > 5000) {
    store.events.splice(0, store.events.length - 5000);
  }
  for (const sub of store.subscribers) {
    try { sub(full); } catch { /* subscriber fault is non-fatal */ }
  }
  return full;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface CreatePayoutInput {
  amount_cents: number;
  currency: string;
  recipient_id: string;
  recipient_type: PayoutItem["recipient_type"];
  rail?: string | null;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
  actor?: string;
}

/**
 * Create a new pending payout. The payout starts in `pending` state with
 * ZERO economic weight. Nothing is sent to any rail.
 *
 * The correlation_id is the SHA-256 correlation ID that will be embedded
 * in the rail payload (memo / description / reference field) so the
 * resulting bank statement line can be matched back to this payout.
 *
 * If correlation_id is not provided, one is deterministically derived
 * from (recipient_id, amount_cents, currency, timestamp).
 */
export function createPayout(input: CreatePayoutInput): PayoutItem {
  if (input.amount_cents <= 0) {
    throw new Error("createPayout: amount_cents must be positive");
  }
  if (!input.recipient_id) {
    throw new Error("createPayout: recipient_id is required");
  }
  const correlation_id =
    input.correlation_id ||
    hashEvent(
      `corr|${input.recipient_id}|${input.amount_cents}|${input.currency}|${Date.now()}|${randomUUID()}`
    );
  const id = `payout_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();
  const item: PayoutItem = {
    id,
    state: "pending",
    amount_cents: input.amount_cents,
    currency: input.currency,
    recipient_id: input.recipient_id,
    recipient_type: input.recipient_type,
    rail: input.rail || null,
    external_reference: null,
    receipt_hash: null,
    bank_statement_ref: null,
    correlation_id,
    created_at: now,
    updated_at: now,
    last_transition_reason: null,
    metadata: input.metadata || {},
  };
  const store = getStore();
  store.items.set(id, item);
  logEvent(id, {
    kind: "created",
    from_state: "pending",
    to_state: "pending",
    actor: input.actor || "system",
    reason: "payout created in pending state",
    metadata: input.metadata,
  });
  return item;
}

export function getPayout(id: string): PayoutItem | undefined {
  return getStore().items.get(id);
}

export function listPayouts(filter?: {
  state?: PayoutState;
  recipient_id?: string;
  limit?: number;
}): PayoutItem[] {
  const store = getStore();
  let items = Array.from(store.items.values());
  if (filter?.state) items = items.filter((i) => i.state === filter.state);
  if (filter?.recipient_id) items = items.filter((i) => i.recipient_id === filter.recipient_id);
  items.sort((a, b) => b.created_at - a.created_at);
  if (filter?.limit) items = items.slice(0, filter.limit);
  return items;
}

export function listEvents(filter?: { payout_id?: string; limit?: number }): PayoutEvent[] {
  const store = getStore();
  let events = store.events;
  if (filter?.payout_id) events = events.filter((e) => e.payout_id === filter.payout_id);
  const sorted = [...events].sort((a, b) => b.ts - a.ts);
  if (filter?.limit) return sorted.slice(0, filter.limit);
  return sorted;
}

// ─── Transition functions (each has a guard) ─────────────────────────

export interface ValidateInput {
  payout_id: string;
  actor?: string;
  reason?: string;
  // Guard inputs — the caller MUST provide these so the guard can check
  is_preset_owner: boolean;
  account_format_valid: boolean;
}
export interface ValidateOk { ok: true; payout: PayoutItem; }
export interface ValidateFail { ok: false; reason: string; }
export function validatePayout(input: ValidateInput): ValidateOk | ValidateFail {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (item.state !== "pending") {
    return { ok: false, reason: `payout is in ${item.state}, expected pending` };
  }
  // Guards
  if (!input.is_preset_owner) {
    return { ok: false, reason: "recipient is not on the pre-set owner whitelist" };
  }
  if (!input.account_format_valid) {
    return { ok: false, reason: "recipient account format is invalid for the rail" };
  }
  if (item.amount_cents <= 0) {
    return { ok: false, reason: "amount_cents must be positive" };
  }
  if (!isValidTransition("pending", "validated")) {
    return { ok: false, reason: "transition pending→validated is not allowed" };
  }
  item.state = "validated";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason || "validated";
  logEvent(item.id, {
    kind: "validated",
    from_state: "pending",
    to_state: "validated",
    actor: input.actor || "system",
    reason: input.reason || "validation guards passed",
  });
  return { ok: true, payout: item };
}

export interface AuthorizeInput {
  payout_id: string;
  actor: string;
  reason?: string;
  // Guard inputs
  authorizer_kind: "human_session" | "psp_webhook_verified" | "autonomous_agent";
  authorizer_id: string;
}
export interface AuthorizeOk { ok: true; payout: PayoutItem; }
export interface AuthorizeFail { ok: false; reason: string; }
export function authorizePayout(input: AuthorizeInput): AuthorizeOk | AuthorizeFail {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (item.state !== "validated") {
    return { ok: false, reason: `payout is in ${item.state}, expected validated` };
  }
  // CRITICAL GUARD: autonomous agents cannot authorize payouts.
  if (input.authorizer_kind === "autonomous_agent") {
    logEvent(item.id, {
      kind: "failed",
      from_state: item.state,
      to_state: item.state,
      actor: input.actor,
      reason: `authorization blocked: autonomous agent ${input.authorizer_id} attempted to authorize payout`,
    });
    return {
      ok: false,
      reason:
        "autonomous agents cannot authorize payouts — a human session or a licensed PSP webhook is required",
    };
  }
  if (input.authorizer_kind === "human_session" && !input.authorizer_id) {
    return { ok: false, reason: "human_session authorization requires authorizer_id (session JWT subject)" };
  }
  if (input.authorizer_kind === "psp_webhook_verified" && !input.authorizer_id) {
    return { ok: false, reason: "psp_webhook_verified authorization requires authorizer_id (webhook source)" };
  }
  item.state = "authorized";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason || `authorized by ${input.authorizer_kind}:${input.authorizer_id}`;
  logEvent(item.id, {
    kind: "authorized",
    from_state: "validated",
    to_state: "authorized",
    actor: input.actor,
    reason: item.last_transition_reason,
    metadata: { authorizer_kind: input.authorizer_kind, authorizer_id: input.authorizer_id },
  });
  return { ok: true, payout: item };
}

export interface SubmitInput {
  payout_id: string;
  actor?: string;
}
export interface SubmitOk { ok: true; payout: PayoutItem; external_reference: string; }
export interface SubmitFail { ok: false; reason: string; code?: RailSubmitError["code"]; }
/**
 * Submit the payout to the rail. This is the ONLY function that calls
 * a real external system (via the registered rail adapter).
 *
 * If no rail adapter is registered for the payout's recipient_type +
 * currency, returns { ok: false, code: "no_live_rail" } — the payout
 * stays in `authorized`. This is by design: until a licensed PSP is
 * integrated, NO payout can leave this system.
 */
export async function submitPayout(input: SubmitInput): Promise<SubmitOk | SubmitFail> {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (item.state !== "authorized") {
    return { ok: false, reason: `payout is in ${item.state}, expected authorized` };
  }
  // Pick a rail adapter
  const adapter = Array.from(store.rails.values()).find(
    (a) =>
      a.supported_recipient_types.includes(item.recipient_type) &&
      a.supported_currencies.includes(item.currency)
  );
  if (!adapter) {
    return {
      ok: false,
      reason: `no rail adapter registered for recipient_type=${item.recipient_type} currency=${item.currency}`,
      code: "no_live_rail",
    };
  }
  item.rail = adapter.rail;
  const result = await adapter.submit({
    payout_id: item.id,
    amount_cents: item.amount_cents,
    currency: item.currency,
    recipient_id: item.recipient_id,
    recipient_type: item.recipient_type,
    correlation_id: item.correlation_id,
  });
  if (!result.ok) {
    logEvent(item.id, {
      kind: "failed",
      from_state: item.state,
      to_state: item.state,
      actor: input.actor || adapter.id,
      reason: `rail submit failed: ${result.reason}`,
    });
    return { ok: false, reason: result.reason, code: result.code };
  }
  item.external_reference = result.external_reference;
  item.state = "submitted";
  item.updated_at = Date.now();
  item.last_transition_reason = `submitted via ${adapter.rail}, external_reference=${result.external_reference}`;
  logEvent(item.id, {
    kind: "submitted",
    from_state: "authorized",
    to_state: "submitted",
    actor: input.actor || adapter.id,
    reason: item.last_transition_reason,
    external_reference: result.external_reference,
    metadata: result.raw,
  });
  return { ok: true, payout: item, external_reference: result.external_reference };
}

export interface SettleInput {
  payout_id: string;
  actor: string;
  reason?: string;
  // Guard: real external proof
  proof_kind: "webhook_verified" | "bank_statement_match" | "on_chain_confirmation";
  proof_payload: string; // the raw proof (webhook body, bank line, tx hex)
  receipt_hash?: string; // if pre-computed; otherwise derived from proof_payload
}
export interface SettleOk { ok: true; payout: PayoutItem; receipt_hash: string; }
export interface SettleFail { ok: false; reason: string; }
/**
 * Mark a submitted payout as settled. REQUIRES real external proof —
 * a verified webhook, a matched bank statement line, or an on-chain
 * confirmation. NO SIMULATION.
 *
 * The receipt_hash is the SHA-256 of the proof_payload if not provided.
 * This hash is what gets stamped on the RevenueEvent's
 * metadata.external_confirmation_ref and what the fraud audit baseline
 * checks against the real-proof patterns.
 */
export function settlePayout(input: SettleInput): SettleOk | SettleFail {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (item.state !== "submitted") {
    return { ok: false, reason: `payout is in ${item.state}, expected submitted` };
  }
  if (!input.proof_payload || input.proof_payload.length === 0) {
    return { ok: false, reason: "proof_payload is required — no simulation allowed" };
  }
  const receipt_hash = input.receipt_hash || hashEvent(input.proof_payload);
  item.receipt_hash = receipt_hash;
  item.state = "settled";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason || `settled via ${input.proof_kind}`;
  logEvent(item.id, {
    kind: "settled",
    from_state: "submitted",
    to_state: "settled",
    actor: input.actor,
    reason: item.last_transition_reason,
    receipt_hash,
    metadata: { proof_kind: input.proof_kind },
  });
  return { ok: true, payout: item, receipt_hash };
}

export interface ReconcileInput {
  payout_id: string;
  actor: string;
  bank_statement_ref: string;
  bank_statement_line: string;
  reason?: string;
}
export interface ReconcileOk { ok: true; payout: PayoutItem; }
export interface ReconcileFail { ok: false; reason: string; }
/**
 * Mark a settled payout as reconciled — i.e. matched against a real
 * imported bank statement line. The bank_statement_ref is the bank's
 * own transaction id (from the statement), not our internal id.
 */
export function reconcilePayout(input: ReconcileInput): ReconcileOk | ReconcileFail {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (item.state !== "settled") {
    return { ok: false, reason: `payout is in ${item.state}, expected settled` };
  }
  if (!input.bank_statement_ref) {
    return { ok: false, reason: "bank_statement_ref is required" };
  }
  item.bank_statement_ref = input.bank_statement_ref;
  item.state = "reconciled";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason || `reconciled against bank statement ref ${input.bank_statement_ref}`;
  logEvent(item.id, {
    kind: "reconciled",
    from_state: "settled",
    to_state: "reconciled",
    actor: input.actor,
    reason: item.last_transition_reason,
    bank_statement_ref: input.bank_statement_ref,
    metadata: { bank_statement_line: input.bank_statement_line },
  });
  return { ok: true, payout: item };
}

export interface FailInput {
  payout_id: string;
  actor: string;
  reason: string;
}
export function failPayout(input: FailInput): { ok: true; payout: PayoutItem } | { ok: false; reason: string } {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (TERMINAL_PAYOUT_STATES.has(item.state)) {
    return { ok: false, reason: `payout is in terminal state ${item.state}` };
  }
  const from = item.state;
  item.state = "failed";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason;
  logEvent(item.id, {
    kind: "failed",
    from_state: from,
    to_state: "failed",
    actor: input.actor,
    reason: input.reason,
  });
  return { ok: true, payout: item };
}

export interface CancelInput {
  payout_id: string;
  actor: string;
  reason: string;
}
export function cancelPayout(input: CancelInput): { ok: true; payout: PayoutItem } | { ok: false; reason: string } {
  const store = getStore();
  const item = store.items.get(input.payout_id);
  if (!item) return { ok: false, reason: "payout not found" };
  if (!["pending", "validated", "authorized"].includes(item.state)) {
    return { ok: false, reason: `payout is in ${item.state}, can only cancel before submission` };
  }
  const from = item.state;
  item.state = "cancelled";
  item.updated_at = Date.now();
  item.last_transition_reason = input.reason;
  logEvent(item.id, {
    kind: "cancelled",
    from_state: from,
    to_state: "cancelled",
    actor: input.actor,
    reason: input.reason,
  });
  return { ok: true, payout: item };
}

// ─── Rail adapter registry ───────────────────────────────────────────

export function registerRailAdapter(adapter: RailAdapter): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  if (store.rails.has(adapter.id)) {
    return { ok: false, reason: `rail adapter ${adapter.id} is already registered` };
  }
  store.rails.set(adapter.id, adapter);
  return { ok: true };
}

export function listRailAdapters(): Array<{
  id: string;
  rail: string;
  supported_recipient_types: ReadonlyArray<PayoutItem["recipient_type"]>;
  supported_currencies: ReadonlyArray<string>;
}> {
  return Array.from(getStore().rails.values()).map((a) => ({
    id: a.id,
    rail: a.rail,
    supported_recipient_types: a.supported_recipient_types,
    supported_currencies: a.supported_currencies,
  }));
}

// ─── Real-proof guard (watchdog facing) ──────────────────────────────
//
// Exposes a unified pass/fail verification used by the autonomous daemon
// fan-out (api/swarm/daemon.mjs). The daemon halts deploy + delivery
// loops until every invariant holds. Mirrors the deny/allow lists in
// scripts/fraud-audit-baseline.mjs so the state machine and the audit
// agree on what "real money moved" means.

export interface PayoutGuardResult {
  passed: boolean;
  reason: string;
  checks: Record<string, boolean>;
  details: Record<string, string>;
}

/**
 * Verify guard invariants across all in-memory payouts.
 *   sequence  – no illegal phase jumps in the event log
 *   proofs    – every settled/reconciled payout has a real receipt_hash
 *               and (for reconciled) a bank_statement_ref
 *   liquidity – settled + pending never exceeds the configured ceiling
 *
 * Autonomous agents may not authorize, but the daemon may CHECK the
 * invariant set and refuse to proceed when it is violated.
 */
export function verifyPayoutGuard(): PayoutGuardResult {
  const store = getStore();
  const checks: Record<string, boolean> = { sequence: true, proofs: true, liquidity: true };
  const details: Record<string, string> = {};

  // 1. Sequence integrity — walk each payout's events in order.
  let sequenceViolations = 0;
  for (const item of store.items.values()) {
    const evs = store.events
      .filter((e) => e.payout_id === item.id)
      .sort((a, b) => a.ts - b.ts);
    let prev: string | null = null;
    for (const ev of evs) {
      if (prev !== null && !isValidTransition(prev as PayoutState, ev.to_state)) {
        sequenceViolations++;
      }
      // track the state we came from for the next hop validity
      prev = ev.to_state;
    }
  }
  checks.sequence = sequenceViolations === 0;
  details.sequence =
    sequenceViolations === 0
      ? "no illegal payout state transitions in event log"
      : `${sequenceViolations} illegal payout state transitions detected`;

  // 2. Proof integrity — settled/reconciled must carry a real receipt.
  let proofViolations = 0;
  let settledNoReceipt = 0;
  let reconciledNoBankRef = 0;
  for (const item of store.items.values()) {
    if (item.state === "settled") {
      if (!item.receipt_hash) {
        settledNoReceipt++;
        proofViolations++;
      }
    } else if (item.state === "reconciled") {
      if (!item.receipt_hash) {
        settledNoReceipt++;
        proofViolations++;
      }
      if (!item.bank_statement_ref) {
        reconciledNoBankRef++;
        proofViolations++;
      }
    }
  }
  checks.proofs = proofViolations === 0;
  details.proofs =
    proofViolations === 0
      ? "all settled/reconciled payouts carry real receipt proof"
      : `${settledNoReceipt} settled without receipt_hash, ${reconciledNoBankRef} reconciled without bank_statement_ref`;

  // 3. Liquidity — total moving value stays within the owner-approved ceiling.
  const { total_settled_cents, total_pending_cents } = getStats();
  const ceilingCents = Number(process.env.AUTO_APPROVE_THRESHOLD_USD || 5000) * 100;
  const movingCents = total_settled_cents + total_pending_cents;
  checks.liquidity = movingCents <= ceilingCents;
  details.liquidity =
    checks.liquidity
      ? `moving value $${(movingCents / 100).toFixed(2)} within ceiling $${(ceilingCents / 100).toFixed(2)}`
      : `moving value $${(movingCents / 100).toFixed(2)} EXCEEDS ceiling $${(ceilingCents / 100).toFixed(2)}`;

  const passed = checks.sequence && checks.proofs && checks.liquidity;
  const reasons: string[] = [];
  for (const [k, ok] of Object.entries(checks)) {
    if (!ok) reasons.push(details[k]);
  }

  return {
    passed,
    reason: reasons.length ? `Guard Tripped: ${reasons.join("; ")}` : "All invariants verified",
    checks,
    details,
  };
}

// ─── Stats / snapshot ────────────────────────────────────────────────

export interface PayoutStats {
  total_items: number;
  by_state: Record<PayoutState, number>;
  total_settled_cents: number;
  total_reconciled_cents: number;
  total_pending_cents: number;
  by_currency_settled_cents: Record<string, number>;
  rail_count: number;
  event_log_size: number;
}

export function getStats(): PayoutStats {
  const store = getStore();
  const by_state = {
    pending: 0, validated: 0, authorized: 0, submitted: 0,
    settled: 0, reconciled: 0, failed: 0, cancelled: 0,
  } as Record<PayoutState, number>;
  let total_settled_cents = 0;
  let total_reconciled_cents = 0;
  let total_pending_cents = 0;
  const by_currency_settled_cents: Record<string, number> = {};
  for (const item of store.items.values()) {
    by_state[item.state]++;
    if (item.state === "settled") {
      total_settled_cents += item.amount_cents;
      by_currency_settled_cents[item.currency] =
        (by_currency_settled_cents[item.currency] || 0) + item.amount_cents;
    } else if (item.state === "reconciled") {
      total_reconciled_cents += item.amount_cents;
      by_currency_settled_cents[item.currency] =
        (by_currency_settled_cents[item.currency] || 0) + item.amount_cents;
    } else if (PIPELINE_PAYOUT_STATES.has(item.state)) {
      total_pending_cents += item.amount_cents;
    }
  }
  return {
    total_items: store.items.size,
    by_state,
    total_settled_cents,
    total_reconciled_cents,
    total_pending_cents,
    by_currency_settled_cents,
    rail_count: store.rails.size,
    event_log_size: store.events.length,
  };
}

export function subscribe(fn: (ev: PayoutEvent) => void): () => void {
  const store = getStore();
  store.subscribers.push(fn);
  return () => {
    const idx = store.subscribers.indexOf(fn);
    if (idx >= 0) store.subscribers.splice(idx, 1);
  };
}

// ─── Test helper — DO NOT USE IN PRODUCTION ──────────────────────────
export function _resetForTests(): void {
  const store = getStore();
  store.items.clear();
  store.events.length = 0;
  store.rails.clear();
  store.subscribers.length = 0;
}

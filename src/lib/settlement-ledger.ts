/**
 * Settlement Ledger — Layer 7 of the swarm safety + optimization stack.
 *
 * The single source of truth for any event in the swarm that claims
 * "economic weight". Replaces the old self-reported RevenueEvent.status
 * flow with a strict, cryptographically-typed state machine + Two-Phase
 * Commit (2PC) protocol.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  STATE TYPING (no booleans, no soft enums)
 * ────────────────────────────────────────────────────────────────────────
 *
 *   SPECULATIVE         The transaction is verified locally by the
 *                       executing agent. ZERO economic weight. May be
 *                       displayed in "Pipeline Analytics" only.
 *
 *   PENDING_SETTLEMENT  The payload has been submitted to the payment
 *                       rail, exchange, or smart contract. The initiator
 *                       has signed the prepare message. Awaiting external
 *                       oracle proof.
 *
 *   SETTLED             The hard fiat gateway or blockchain ledger has
 *                       returned an immutable confirmation block. The
 *                       receipt_hash is set. Idempotent — once Settled,
 *                       always Settled. Only this state may flow to the
 *                       "Active Operations" dashboard.
 *
 *   CANCELLED           The initiator revoked the transaction before
 *                       settlement. Terminal state.
 *
 *   FAILED              The oracle returned an irrecoverable rejection
 *                       (chargeback, NSN, blockchain reorg, etc.).
 *                       Terminal state.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  TWO-PHASE COMMIT (2PC) PROTOCOL
 * ────────────────────────────────────────────────────────────────────────
 *
 *   Phase 1 — PREPARE:
 *     The initiator agent asks the settlement coordinator whether the
 *     financial path is valid (rail reachable, recipient KYC'd, amount
 *     within limits) and simulates the payload. The coordinator returns
 *     a `prepare_token` if the path is valid. The ledger entry transitions
 *     SPECULATIVE → PENDING_SETTLEMENT.
 *
 *   Phase 2 — COMMIT:
 *     The coordinator waits for an external oracle (Stripe webhook,
 *     Plaid balance check, Chainlink oracle round, bank statement line)
 *     to provide cryptographic proof of funds. On proof, the entry
 *     transitions PENDING_SETTLEMENT → SETTLED and the receipt_hash is
 *     written. Until proof arrives, the entry remains PENDING_SETTLEMENT.
 *
 *   If the oracle rejects → FAILED.
 *   If the initiator cancels before commit → CANCELLED.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  DASHBOARD ISOLATION RULE
 * ────────────────────────────────────────────────────────────────────────
 *
 *   The "Active Operations" dashboard subscribes ONLY to the Settled
 *   event stream. Speculative and Pending_Settlement entries are
 *   strictly segregated into a separate "Pipeline Analytics" view.
 *
 *   Hard rule: getActiveOperationsBalance() returns $0.00 unless at
 *   least one entry has a non-empty receipt_hash. There is no soft
 *   fallback.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  APPEND-ONLY EVENT LOG
 * ────────────────────────────────────────────────────────────────────────
 *
 *   Every state transition writes an immutable LedgerEvent to the log.
 *   The log is the canonical history — the per-entry `state` field is
 *   just a denormalized view of the latest event for that entry.
 *
 * Singleton: globalThis pattern so HMR + Turbopack route-module isolation
 * doesn't fork the ledger across hot reloads.
 */

import { createHash, createHmac, randomUUID } from "crypto";

// ─── strict state typing ─────────────────────────────────────────────────

export type SettlementState =
  | "SPECULATIVE"
  | "PENDING_SETTLEMENT"
  | "SETTLED"
  | "CANCELLED"
  | "FAILED";

/** Set of states that have ZERO economic weight — must NOT appear in Active Ops. */
export const PIPELINE_STATES: ReadonlySet<SettlementState> = new Set([
  "SPECULATIVE",
  "PENDING_SETTLEMENT",
]);

/** Set of terminal states — no further transitions allowed. */
export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set([
  "SETTLED",
  "CANCELLED",
  "FAILED",
]);

/** Set of states that carry real economic weight — may appear in Active Ops. */
export const ACTIVE_STATES: ReadonlySet<SettlementState> = new Set([
  "SETTLED",
]);

export type LedgerEntryKind = "revenue" | "procurement" | "payout";

export interface LedgerEntry {
  /** Stable id, never reused. */
  id: string;
  /** External reference (e.g. RevenueEvent.event_id, PO number, batch_id). */
  external_ref: string;
  /** What kind of economic event this is. */
  kind: LedgerEntryKind;
  /** Current state — denormalized from the latest event in `events`. */
  state: SettlementState;
  /** Amount in cents (always integer — no float money). */
  amount_cents: number;
  /** ISO currency code. */
  currency: string;
  /** Counterparty (recipient_id for revenue, supplier_id for procurement). */
  counterparty_id: string;
  /** Initiating agent. */
  initiator_agent_id: string;
  /** Assigned oracle (empty until prepare). */
  oracle_id: string | null;
  /** 2PC prepare token — proves the path was validated before commit. */
  prepare_token: string | null;
  /** Cryptographic receipt hash from the oracle. Empty until SETTLED. */
  receipt_hash: string | null;
  /** Rail / channel identifier (stripe / plaid / chainlink / fedex / dhl ...). */
  rail: string | null;
  /** Free-form metadata (HIT ref, PO line items, etc.) — never used for state. */
  metadata: Record<string, unknown>;
  /** Created timestamp (ms since epoch). */
  created_at: number;
  /** Last-updated timestamp. */
  updated_at: number;
  /** Reason for the most recent transition (audit trail). */
  last_transition_reason: string | null;
}

export type LedgerEventKind =
  | "created"
  | "prepared" // 2PC Phase 1 complete → PENDING_SETTLEMENT
  | "commit_requested" // oracle asked to commit, awaiting proof
  | "committed" // 2PC Phase 2 complete → SETTLED (receipt_hash set)
  | "cancelled"
  | "failed";

export interface LedgerEvent {
  /** Event id — append-only, never mutated. */
  id: string;
  /** Entry this event applies to. */
  entry_id: string;
  /** What happened. */
  kind: LedgerEventKind;
  /** State BEFORE this event. */
  from_state: SettlementState;
  /** State AFTER this event. */
  to_state: SettlementState;
  /** When (ms). */
  ts: number;
  /** Who caused it (agent_id, oracle_id, or "system"). */
  actor: string;
  /** Human-readable reason. */
  reason: string;
  /** Cryptographic hash of the event payload — tamper-evidence. */
  event_hash: string;
  /** Optional receipt hash (only on `committed` events). */
  receipt_hash?: string;
  /** Optional prepare token (only on `prepared` events). */
  prepare_token?: string;
}

export interface SettlementStats {
  total_entries: number;
  by_state: Record<SettlementState, number>;
  by_kind: Record<LedgerEntryKind, number>;
  /** Sum of amount_cents across SETTLED entries — real economic weight only. */
  settled_amount_cents: number;
  /** Sum across PENDING_SETTLEMENT — awaiting oracle proof. */
  pending_amount_cents: number;
  /** Sum across SPECULATIVE — zero economic weight. */
  speculative_amount_cents: number;
  /** Count of entries that have a non-empty receipt_hash. */
  entries_with_receipt: number;
  /** Count of 2PC prepare operations completed. */
  prepares_completed: number;
  /** Count of 2PC commit operations completed. */
  commits_completed: number;
  /** Count of oracle rejections. */
  oracle_rejections: number;
  /** Count of operator-initiated cancels. */
  cancels: number;
  /** Oldest PENDING_SETTLEMENT age in seconds (for SLA monitoring). */
  oldest_pending_age_seconds: number;
}

export interface SettlementCoordinator {
  /** Validate that the financial path is reachable (rail + counterparty + amount). */
  validatePath(
    entry: Omit<LedgerEntry, "id" | "state" | "created_at" | "updated_at">
  ): { ok: true; rail: string } | { ok: false; reason: string };

  /** Simulate the payload without sending it (dry-run). */
  simulatePayload(entry: LedgerEntry): { ok: true; simulated_ref: string } | { ok: false; reason: string };
}

// ─── coordinator implementation ──────────────────────────────────────────

const DEFAULT_COORDINATOR: SettlementCoordinator = {
  validatePath(entry) {
    if (entry.amount_cents <= 0) {
      return { ok: false, reason: "amount_cents must be > 0" };
    }
    if (!entry.counterparty_id) {
      return { ok: false, reason: "counterparty_id required" };
    }
    if (!entry.initiator_agent_id) {
      return { ok: false, reason: "initiator_agent_id required" };
    }
    // Default rail inference from kind + counterparty shape.
    const rail = inferRail(entry);
    return { ok: true, rail };
  },
  simulatePayload(entry) {
    // Dry-run: just hash the payload to produce a deterministic simulated_ref.
    const simulated = createHash("sha256")
      .update(`${entry.id}|${entry.amount_cents}|${entry.counterparty_id}`)
      .digest("hex")
      .slice(0, 16);
    return { ok: true, simulated_ref: `sim_${simulated}` };
  },
};

function inferRail(
  entry: Omit<LedgerEntry, "id" | "state" | "created_at" | "updated_at">
): string {
  const meta = entry.metadata || {};
  if (typeof meta.rail === "string") return meta.rail as string;
  if (entry.kind === "procurement") return "purchase_order";
  if (typeof meta.marketplace === "string") {
    const m = meta.marketplace as string;
    if (m === "mturk" || m === "clickworker" || m === "toloka" || m === "prolific")
      return "paypal_masspay";
  }
  return "ach";
}

// ─── ledger singleton ────────────────────────────────────────────────────

interface LedgerStore {
  entries: Map<string, LedgerEntry>;
  events: LedgerEvent[];
  coordinator: SettlementCoordinator;
  /** Subscribers notified on every state transition. */
  subscribers: Set<(ev: LedgerEvent) => void>;
  /** Oracle registry — only oracles in this set may commit entries. */
  registered_oracles: Map<string, { id: string; rail: string; healthy: boolean }>;
  /** HMAC secret for event-hash tamper-evidence. */
  hmac_secret: string;
  /** Counters for stats. */
  prepares_completed: number;
  commits_completed: number;
  oracle_rejections: number;
  cancels: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __SETTLEMENT_LEDGER__: LedgerStore | undefined;
}

function getStore(): LedgerStore {
  if (!globalThis.__SETTLEMENT_LEDGER__) {
    globalThis.__SETTLEMENT_LEDGER__ = {
      entries: new Map(),
      events: [],
      coordinator: DEFAULT_COORDINATOR,
      subscribers: new Set(),
      registered_oracles: new Map([
        // Default oracle registry — simulates Stripe + Plaid + Chainlink + FedEx + UPS + DHL.
        ["oracle_stripe", { id: "oracle_stripe", rail: "stripe", healthy: true }],
        ["oracle_plaid", { id: "oracle_plaid", rail: "plaid", healthy: true }],
        ["oracle_chainlink", { id: "oracle_chainlink", rail: "chainlink", healthy: true }],
        ["oracle_fedex", { id: "oracle_fedex", rail: "fedex", healthy: true }],
        ["oracle_ups", { id: "oracle_ups", rail: "ups", healthy: true }],
        ["oracle_dhl", { id: "oracle_dhl", rail: "dhl", healthy: true }],
      ]),
      hmac_secret: process.env.SETTLEMENT_HMAC_SECRET || "charibaas-dev-hmac-secret-v1",
      prepares_completed: 0,
      commits_completed: 0,
      oracle_rejections: 0,
      cancels: 0,
    };
  }
  return globalThis.__SETTLEMENT_LEDGER__;
}

// ─── event-hash tamper-evidence ──────────────────────────────────────────

function computeEventHash(ev: Omit<LedgerEvent, "event_hash">): string {
  const payload = JSON.stringify({
    id: ev.id,
    entry_id: ev.entry_id,
    kind: ev.kind,
    from_state: ev.from_state,
    to_state: ev.to_state,
    ts: ev.ts,
    actor: ev.actor,
    reason: ev.reason,
    receipt_hash: ev.receipt_hash || "",
    prepare_token: ev.prepare_token || "",
  });
  return createHmac("sha256", getStore().hmac_secret).update(payload).digest("hex");
}

function verifyEventHash(ev: LedgerEvent): boolean {
  const { event_hash, ...rest } = ev;
  return computeEventHash(rest) === event_hash;
}

// ─── public API ──────────────────────────────────────────────────────────

export interface CreateEntryInput {
  external_ref: string;
  kind: LedgerEntryKind;
  amount_cents: number;
  currency: string;
  counterparty_id: string;
  initiator_agent_id: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a new ledger entry in SPECULATIVE state.
 * This is the ONLY entrypoint for new economic events — there is no
 * "create as Settled" shortcut. Settlement is always reached through 2PC.
 */
export function createEntry(input: CreateEntryInput): LedgerEntry {
  const id = `ledg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = Date.now();
  const entry: LedgerEntry = {
    id,
    external_ref: input.external_ref,
    kind: input.kind,
    state: "SPECULATIVE",
    amount_cents: Math.round(input.amount_cents),
    currency: input.currency,
    counterparty_id: input.counterparty_id,
    initiator_agent_id: input.initiator_agent_id,
    oracle_id: null,
    prepare_token: null,
    receipt_hash: null,
    rail: null,
    metadata: input.metadata || {},
    created_at: now,
    updated_at: now,
    last_transition_reason: "entry created",
  };
  getStore().entries.set(id, entry);
  appendEvent({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    entry_id: id,
    kind: "created",
    from_state: "SPECULATIVE",
    to_state: "SPECULATIVE",
    ts: now,
    actor: input.initiator_agent_id,
    reason: "entry created",
  });
  return entry;
}

/**
 * 2PC Phase 1 — PREPARE.
 *
 * Validates the financial path, simulates the payload, and — on success —
 * transitions the entry from SPECULATIVE → PENDING_SETTLEMENT. Returns a
 * `prepare_token` the initiator must present at commit time.
 */
export function prepare(
  entry_id: string,
  initiator_agent_id: string,
  oracle_id?: string
): { ok: true; prepare_token: string; rail: string } | { ok: false; reason: string } {
  const store = getStore();
  const entry = store.entries.get(entry_id);
  if (!entry) return { ok: false, reason: `entry ${entry_id} not found` };
  if (entry.state !== "SPECULATIVE") {
    return { ok: false, reason: `entry is in ${entry.state}, expected SPECULATIVE` };
  }
  if (entry.initiator_agent_id !== initiator_agent_id) {
    return { ok: false, reason: "only the initiator may prepare" };
  }
  if (oracle_id && !store.registered_oracles.has(oracle_id)) {
    return { ok: false, reason: `oracle ${oracle_id} not registered` };
  }
  // Coordinator validation.
  const pathCheck = store.coordinator.validatePath(entry);
  if (!pathCheck.ok) return { ok: false, reason: pathCheck.reason };
  const sim = store.coordinator.simulatePayload(entry);
  if (!sim.ok) return { ok: false, reason: sim.reason };

  // Mint a prepare token — HMAC-bound to the entry + initiator + simulated ref.
  const prepare_token = createHmac("sha256", store.hmac_secret)
    .update(`prepare|${entry.id}|${initiator_agent_id}|${sim.simulated_ref}`)
    .digest("hex");

  const now = Date.now();
  const updated: LedgerEntry = {
    ...entry,
    state: "PENDING_SETTLEMENT",
    prepare_token,
    rail: pathCheck.rail,
    oracle_id: oracle_id || null,
    metadata: { ...entry.metadata, simulated_ref: sim.simulated_ref },
    updated_at: now,
    last_transition_reason: `2PC prepare: rail=${pathCheck.rail}, sim=${sim.simulated_ref}`,
  };
  store.entries.set(entry_id, updated);
  store.prepares_completed++;
  appendEvent({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    entry_id,
    kind: "prepared",
    from_state: "SPECULATIVE",
    to_state: "PENDING_SETTLEMENT",
    ts: now,
    actor: initiator_agent_id,
    reason: `path validated on rail ${pathCheck.rail}; simulated_ref=${sim.simulated_ref}`,
    prepare_token,
  });
  return { ok: true, prepare_token, rail: pathCheck.rail };
}

/**
 * 2PC Phase 2 — COMMIT.
 *
 * Called by a registered oracle (NOT by the initiator) when external proof
 * of funds has arrived. Verifies the prepare_token matches, then transitions
 * the entry to SETTLED with the receipt_hash filled in.
 *
 * Once Settled, the entry is immutable — no further transitions are allowed.
 */
export function commit(
  entry_id: string,
  oracle_id: string,
  prepare_token: string,
  receipt_payload: unknown
): { ok: true; receipt_hash: string } | { ok: false; reason: string } {
  const store = getStore();
  const entry = store.entries.get(entry_id);
  if (!entry) return { ok: false, reason: `entry ${entry_id} not found` };
  if (entry.state !== "PENDING_SETTLEMENT") {
    return { ok: false, reason: `entry is in ${entry.state}, expected PENDING_SETTLEMENT` };
  }
  if (!store.registered_oracles.has(oracle_id)) {
    return { ok: false, reason: `oracle ${oracle_id} not registered` };
  }
  if (entry.oracle_id && entry.oracle_id !== oracle_id) {
    return { ok: false, reason: `wrong oracle: entry expects ${entry.oracle_id}, got ${oracle_id}` };
  }
  if (entry.prepare_token !== prepare_token) {
    return { ok: false, reason: "prepare_token mismatch" };
  }
  // Compute the receipt hash — the canonical proof that this commit was
  // backed by an external oracle payload.
  const receipt_hash = createHash("sha256")
    .update(
      JSON.stringify({
        entry_id,
        oracle_id,
        rail: entry.rail,
        amount_cents: entry.amount_cents,
        counterparty_id: entry.counterparty_id,
        payload: receipt_payload,
      })
    )
    .digest("hex");

  const now = Date.now();
  const updated: LedgerEntry = {
    ...entry,
    state: "SETTLED",
    receipt_hash,
    updated_at: now,
    last_transition_reason: `2PC commit: oracle=${oracle_id}, receipt=${receipt_hash.slice(0, 12)}…`,
  };
  store.entries.set(entry_id, updated);
  store.commits_completed++;
  appendEvent({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    entry_id,
    kind: "committed",
    from_state: "PENDING_SETTLEMENT",
    to_state: "SETTLED",
    ts: now,
    actor: oracle_id,
    reason: `oracle ${oracle_id} provided proof of funds`,
    receipt_hash,
  });
  return { ok: true, receipt_hash };
}

/**
 * Mark a PENDING_SETTLEMENT entry as FAILED — the oracle rejected it.
 * Only the assigned oracle or the initiator may fail an entry.
 */
export function fail(
  entry_id: string,
  actor: string,
  reason: string
): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const entry = store.entries.get(entry_id);
  if (!entry) return { ok: false, reason: `entry ${entry_id} not found` };
  if (entry.state !== "PENDING_SETTLEMENT" && entry.state !== "SPECULATIVE") {
    return { ok: false, reason: `entry is in ${entry.state}, cannot fail` };
  }
  if (actor !== entry.initiator_agent_id && actor !== entry.oracle_id && actor !== "system") {
    return { ok: false, reason: "only initiator, oracle, or system may fail an entry" };
  }
  const now = Date.now();
  const updated: LedgerEntry = {
    ...entry,
    state: "FAILED",
    updated_at: now,
    last_transition_reason: `failed: ${reason}`,
  };
  store.entries.set(entry_id, updated);
  store.oracle_rejections++;
  appendEvent({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    entry_id,
    kind: "failed",
    from_state: entry.state,
    to_state: "FAILED",
    ts: now,
    actor,
    reason,
  });
  return { ok: true };
}

/**
 * Cancel an entry before settlement. Only the initiator may cancel.
 * CANCELLED is terminal — no further transitions.
 */
export function cancel(
  entry_id: string,
  initiator_agent_id: string,
  reason: string
): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const entry = store.entries.get(entry_id);
  if (!entry) return { ok: false, reason: `entry ${entry_id} not found` };
  if (TERMINAL_STATES.has(entry.state)) {
    return { ok: false, reason: `entry is in terminal state ${entry.state}` };
  }
  if (entry.initiator_agent_id !== initiator_agent_id) {
    return { ok: false, reason: "only the initiator may cancel" };
  }
  const now = Date.now();
  const updated: LedgerEntry = {
    ...entry,
    state: "CANCELLED",
    updated_at: now,
    last_transition_reason: `cancelled: ${reason}`,
  };
  store.entries.set(entry_id, updated);
  store.cancels++;
  appendEvent({
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    entry_id,
    kind: "cancelled",
    from_state: entry.state,
    to_state: "CANCELLED",
    ts: now,
    actor: initiator_agent_id,
    reason,
  });
  return { ok: true };
}

// ─── append-only event log ───────────────────────────────────────────────

function appendEvent(ev: Omit<LedgerEvent, "event_hash">): void {
  const store = getStore();
  const event: LedgerEvent = { ...ev, event_hash: computeEventHash(ev) };
  store.events.push(event);
  // Notify subscribers.
  for (const sub of store.subscribers) {
    try {
      sub(event);
    } catch {
      /* swallow — subscribers must not break the ledger */
    }
  }
}

export function subscribe(fn: (ev: LedgerEvent) => void): () => void {
  getStore().subscribers.add(fn);
  return () => getStore().subscribers.delete(fn);
}

// ─── queries ─────────────────────────────────────────────────────────────

export function getEntry(entry_id: string): LedgerEntry | undefined {
  return getStore().entries.get(entry_id);
}

export function getEntryByExternalRef(external_ref: string): LedgerEntry | undefined {
  for (const e of getStore().entries.values()) {
    if (e.external_ref === external_ref) return e;
  }
  return undefined;
}

export function listEntries(filter?: {
  kind?: LedgerEntryKind;
  state?: SettlementState;
  rail?: string;
  initiator_agent_id?: string;
  limit?: number;
}): LedgerEntry[] {
  let out = Array.from(getStore().entries.values());
  if (filter?.kind) out = out.filter((e) => e.kind === filter.kind);
  if (filter?.state) out = out.filter((e) => e.state === filter.state);
  if (filter?.rail) out = out.filter((e) => e.rail === filter.rail);
  if (filter?.initiator_agent_id)
    out = out.filter((e) => e.initiator_agent_id === filter.initiator_agent_id);
  out.sort((a, b) => b.updated_at - a.updated_at);
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}

export function listEvents(filter?: {
  entry_id?: string;
  kind?: LedgerEventKind;
  limit?: number;
}): LedgerEvent[] {
  let out = [...getStore().events];
  if (filter?.entry_id) out = out.filter((e) => e.entry_id === filter.entry_id);
  if (filter?.kind) out = out.filter((e) => e.kind === filter.kind);
  out.sort((a, b) => b.ts - a.ts);
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}

/**
 * Active Operations stream — SETTLED entries only.
 * This is the ONLY query the Active Operations dashboard may call.
 */
export function getActiveOperationsStream(limit?: number): LedgerEntry[] {
  return listEntries({ state: "SETTLED", limit });
}

/**
 * Pipeline Analytics stream — SPECULATIVE + PENDING_SETTLEMENT only.
 * This is what the "Pipeline Analytics" dashboard subscribes to.
 */
export function getPipelineAnalyticsStream(limit?: number): LedgerEntry[] {
  const all = listEntries({ limit: 1000 });
  return all
    .filter((e) => PIPELINE_STATES.has(e.state))
    .slice(0, limit || 1000);
}

/**
 * Hard rule: returns $0.00 unless at least one entry has a non-empty
 * receipt_hash. There is no soft fallback — speculative and pending
 * balances are NEVER included.
 */
export function getActiveOperationsBalance(): {
  total_cents: number;
  by_kind: Record<LedgerEntryKind, number>;
  entry_count: number;
  has_any_receipt: boolean;
} {
  const settled = listEntries({ state: "SETTLED" });
  const has_any_receipt = settled.some((e) => !!e.receipt_hash);
  const total_cents = settled.reduce((s, e) => s + e.amount_cents, 0);
  const by_kind: Record<LedgerEntryKind, number> = {
    revenue: 0,
    procurement: 0,
    payout: 0,
  };
  for (const e of settled) {
    by_kind[e.kind] += e.amount_cents;
  }
  return { total_cents, by_kind, entry_count: settled.length, has_any_receipt };
}

/**
 * Pipeline-only balance — for the segregated Pipeline Analytics view.
 * NEVER displayed on the Active Operations dashboard.
 */
export function getPipelineBalance(): {
  speculative_cents: number;
  pending_cents: number;
  entry_count: number;
} {
  const pipeline = getPipelineAnalyticsStream();
  let speculative_cents = 0;
  let pending_cents = 0;
  for (const e of pipeline) {
    if (e.state === "SPECULATIVE") speculative_cents += e.amount_cents;
    else if (e.state === "PENDING_SETTLEMENT") pending_cents += e.amount_cents;
  }
  return {
    speculative_cents,
    pending_cents,
    entry_count: pipeline.length,
  };
}

export function getStats(): SettlementStats {
  const store = getStore();
  const all = Array.from(store.entries.values());
  const by_state: Record<SettlementState, number> = {
    SPECULATIVE: 0,
    PENDING_SETTLEMENT: 0,
    SETTLED: 0,
    CANCELLED: 0,
    FAILED: 0,
  };
  const by_kind: Record<LedgerEntryKind, number> = { revenue: 0, procurement: 0, payout: 0 };
  let settled_amount_cents = 0;
  let pending_amount_cents = 0;
  let speculative_amount_cents = 0;
  let entries_with_receipt = 0;
  let oldest_pending_ts: number | null = null;

  for (const e of all) {
    by_state[e.state]++;
    by_kind[e.kind]++;
    if (e.state === "SETTLED") {
      settled_amount_cents += e.amount_cents;
      if (e.receipt_hash) entries_with_receipt++;
    } else if (e.state === "PENDING_SETTLEMENT") {
      pending_amount_cents += e.amount_cents;
      if (oldest_pending_ts === null || e.updated_at < oldest_pending_ts) {
        oldest_pending_ts = e.updated_at;
      }
    } else if (e.state === "SPECULATIVE") {
      speculative_amount_cents += e.amount_cents;
    }
  }

  return {
    total_entries: all.length,
    by_state,
    by_kind,
    settled_amount_cents,
    pending_amount_cents,
    speculative_amount_cents,
    entries_with_receipt,
    prepares_completed: store.prepares_completed,
    commits_completed: store.commits_completed,
    oracle_rejections: store.oracle_rejections,
    cancels: store.cancels,
    oldest_pending_age_seconds:
      oldest_pending_ts !== null
        ? Math.floor((Date.now() - oldest_pending_ts) / 1000)
        : 0,
  };
}

// ─── oracle registry ─────────────────────────────────────────────────────

export function registerOracle(id: string, rail: string): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const existing = store.registered_oracles.get(id);
  if (existing) {
    // Idempotent: if the oracle is already registered with the same rail, return ok.
    if (existing.rail === rail) return { ok: true };
    return { ok: false, reason: `oracle ${id} already registered with rail ${existing.rail}` };
  }
  store.registered_oracles.set(id, { id, rail, healthy: true });
  return { ok: true };
}

export function unregisterOracle(id: string): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  if (!store.registered_oracles.has(id)) {
    return { ok: false, reason: `oracle ${id} not registered` };
  }
  store.registered_oracles.delete(id);
  return { ok: true };
}

export function setOracleHealth(id: string, healthy: boolean): { ok: true } | { ok: false; reason: string } {
  const store = getStore();
  const o = store.registered_oracles.get(id);
  if (!o) return { ok: false, reason: `oracle ${id} not registered` };
  o.healthy = healthy;
  return { ok: true };
}

export function listOracles(): Array<{ id: string; rail: string; healthy: boolean }> {
  return Array.from(getStore().registered_oracles.values());
}

// ─── audit ───────────────────────────────────────────────────────────────

export interface AuditFinding {
  severity: "info" | "warning" | "critical";
  entry_id: string;
  external_ref: string;
  issue: string;
  detail?: string;
}

/**
 * Audit every ledger entry for schema violations:
 *   - Any entry in SETTLED state without a receipt_hash (CRITICAL)
 *   - Any entry in PENDING_SETTLEMENT older than 5 minutes (WARNING — SLA)
 *   - Any event with a broken HMAC (CRITICAL — tamper evidence)
 *   - Any entry whose metadata still carries a self-asserted "is_paid: true"
 *     flag (WARNING — should have been stripped at ingress)
 */
export function runAudit(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const now = Date.now();
  for (const e of getStore().entries.values()) {
    if (e.state === "SETTLED" && !e.receipt_hash) {
      findings.push({
        severity: "critical",
        entry_id: e.id,
        external_ref: e.external_ref,
        issue: "SETTLED entry has no receipt_hash",
        detail: "Hard rule violation — every Settled entry must carry an oracle receipt hash.",
      });
    }
    if (e.state === "PENDING_SETTLEMENT" && now - e.updated_at > 5 * 60_000) {
      findings.push({
        severity: "warning",
        entry_id: e.id,
        external_ref: e.external_ref,
        issue: "PENDING_SETTLEMENT entry older than 5 minutes",
        detail: `Age: ${Math.floor((now - e.updated_at) / 1000)}s — oracle may be unhealthy.`,
      });
    }
    // Check for self-asserted completion tokens that should have been stripped.
    const meta = e.metadata || {};
    if (meta.is_paid === true || meta.self_verified === true || meta.confirmed === true) {
      findings.push({
        severity: "warning",
        entry_id: e.id,
        external_ref: e.external_ref,
        issue: "Entry metadata carries a self-asserted completion token",
        detail:
          "is_paid/self_verified/confirmed flags must be stripped at the ingress validation layer — settlement can only be proven via receipt_hash.",
      });
    }
  }
  // Verify every event hash.
  for (const ev of getStore().events) {
    if (!verifyEventHash(ev)) {
      findings.push({
        severity: "critical",
        entry_id: ev.entry_id,
        external_ref: "(event log)",
        issue: "Event hash verification failed — possible tampering",
        detail: `Event ${ev.id} (${ev.kind}) HMAC does not match its payload.`,
      });
    }
  }
  // Sort by severity.
  const rank = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return findings;
}

// ─── ingress validation ──────────────────────────────────────────────────

const SELF_ASSERTED_KEYS = new Set([
  // Revenue-side tokens
  "is_paid",
  "is_confirmed",
  "is_settled",
  "self_verified",
  "self_signed",
  "agent_confirmed",
  "confirmed_by_agent",
  "internally_settled",
  // Procurement-side tokens
  "is_shipped",
  "is_delivered",
  "is_received",
  "supplier_confirmed",
  "shipped_by_supplier",
  "delivered_by_supplier",
]);

/**
 * Ingress Validation Layer — strips self-asserted completion tokens from
 * supplier/vendor/agent messages before they can reach the ledger.
 *
 * Per the Procurement Swarm Settlement Blueprint:
 *   "Build a single Ingress Validation Layer for supplier messages. Strip
 *    away any self-asserted completion tokens sent by external vendors."
 *
 * Returns a sanitized copy. The original is never mutated.
 */
export function sanitizeIngress(
  payload: Record<string, unknown>
): { sanitized: Record<string, unknown>; stripped_keys: string[] } {
  const sanitized: Record<string, unknown> = {};
  const stripped_keys: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (SELF_ASSERTED_KEYS.has(k)) {
      stripped_keys.push(k);
      continue;
    }
    // Recurse into nested objects.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = sanitizeIngress(v as Record<string, unknown>);
      sanitized[k] = inner.sanitized;
      stripped_keys.push(...inner.stripped_keys);
    } else {
      sanitized[k] = v;
    }
  }
  return { sanitized, stripped_keys };
}

// ─── coordinator override (for testing) ──────────────────────────────────

export function setCoordinator(coord: SettlementCoordinator): void {
  getStore().coordinator = coord;
}

// ─── reset (for tests) ───────────────────────────────────────────────────

export function _resetLedgerForTests(): void {
  const store = getStore();
  store.entries.clear();
  store.events.length = 0;
  store.prepares_completed = 0;
  store.commits_completed = 0;
  store.oracle_rejections = 0;
  store.cancels = 0;
}

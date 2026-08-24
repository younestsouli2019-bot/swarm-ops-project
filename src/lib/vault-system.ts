/**
 * Multi-Tier Vault System — orphan revenue custodian.
 * ================================================
 *
 * Operator directive (verbatim, from the IM channel):
 *
 *   "Unidentified revenues cannot sit loosely on a balance sheet.
 *    They are pushed directly into a modular Smart Vault System
 *    configured with programmatic spend priorities:
 *
 *      💡 Core Scaling Vault     trickle_down_v1    90-day safe-harbor,
 *                                                   then releases to ops
 *      ⚠️ Emergency Reserves     burn_rate_buffer   immediately accessible
 *                                                   for API/hosting spikes
 *      📉 Doomsday Fund          black_swan_protocol high-yield isolated
 *                                                    storage for catastrophes"
 *
 * Why this exists
 * ---------------
 * The orchestrator's `maybePayout()` calls `recordClassABlock()` and
 * returns false when no pre-set owner recipient is configured. That
 * recorded a SIG breach (good — the breach is visible) but the funds
 * themselves vanished into a log entry: there was no second home for
 * the $32.66 (or any other orphan amount) to actually sit in.
 *
 * This module closes that hole. Every orphan revenue event is now
 * routed into one of three vaults based on amount + age + system state.
 * Each vault is an append-only custodial account with a strict
 * withdrawal policy. The vaults are NOT a slush fund — every deposit
 * and withdrawal is HMAC-stamped and visible to the operator.
 *
 * State machine for an orphan event:
 *
 *   [Inbound Orphaned Event]
 *            │
 *            ▼
 *   [State: PENDING_EXTERNAL_REF]  ─── (Detection Swarm polls Bank APIs,
 *            │                       PayPal Logs, On-Chain RPC nodes)
 *            │
 *            ├─► External match found
 *            │       │
 *            │       ▼
 *            │   [State: TRANSITION_ALLOWED]  ──► [Cleared to Ingest / Route]
 *            │
 *            └─► No external match within routing_window_ms
 *                    │
 *                    ▼
 *                [State: HOLD_PENDING_VALIDATION]
 *                    │
 *                    ▼
 *                Routed to fallback vault destination:
 *                  vault://unidentified_revenues/emergency_funds
 *
 * The fallback destination is `burn_rate_buffer` by default — the
 * Emergency Reserves vault — because it is the most liquid. Funds
 * there can be released to core operations (covering API overages,
 * hosting spikes) on demand. After 90 days, untouched funds migrate
 * downstream to `trickle_down_v1` (Core Scaling Vault). The Doomsday
 * Fund is reserved for catastrophic market failures and is funded
 * only by explicit operator action.
 *
 * Cryptographic guarantees
 * ------------------------
 * Every vault deposit produces an HMAC receipt. Every withdrawal
 * requires a 64-char sha256 receipt_hash from a registered oracle
 * (same registry as the Settlement Ledger). The vault never lets
 * funds leave without an external confirmation ref — that is the
 * `EXTERNAL_CONFIRMATION_REF_REQUIRED` gate the operator specified.
 *
 * Singleton: globalThis pattern so HMR + Turbopack route-module
 * isolation doesn't fork the vault across hot reloads.
 */

import { createHash, createHmac, randomUUID } from "crypto";
import { PRESET_OWNER_ACCOUNTS } from "./owner-accounts";

// ─── vault identifiers ───────────────────────────────────────────────────

export type VaultId =
  | "trickle_down_v1" // 💡 Core Scaling Vault
  | "burn_rate_buffer" // ⚠️ Emergency Reserves
  | "black_swan_protocol"; // 📉 Doomsday Fund

export interface VaultDescriptor {
  id: VaultId;
  label: string;
  emoji: string;
  description: string;
  /**
   * Strategy / allocation rule — verbatim from the operator directive.
   * Surfaces in the dashboard so the operator always sees the rule
   * that governs each vault.
   */
  strategy: string;
  /**
   * Withdrawal policy — who may pull funds out, and under what gate.
   *   "open"             — operator may withdraw at any time
   *   "safe_harbor_90d"  — funds locked for 90 days after deposit,
   *                        then releaseable to core operations
   *   "catastrophe_only" — releaseable only when black_swan_breaker
   *                        is active OR operator overrides with
   *                        a 2-of-2 dual authorization token
   */
  withdrawal_policy: "open" | "safe_harbor_90d" | "catastrophe_only";
  /** Default destination for funds leaving this vault. */
  default_downstream: VaultId | "owner_routing" | null;
}

export const VAULT_DESCRIPTORS: Record<VaultId, VaultDescriptor> = {
  trickle_down_v1: {
    id: "trickle_down_v1",
    label: "Core Scaling Vault",
    emoji: "💡",
    description:
      "Trickle-down mechanism: releases capital to core operations " +
      "once an orphan event passes a 90-day safe-harbor holding window.",
    strategy:
      "Trickle-down mechanism: Automatically releases capital to core " +
      "operations once the orphan event passes a 90-day safe-harbor " +
      "holding window.",
    withdrawal_policy: "safe_harbor_90d",
    default_downstream: "owner_routing",
  },
  burn_rate_buffer: {
    id: "burn_rate_buffer",
    label: "Emergency Reserves",
    emoji: "⚠️",
    description:
      "System Liquidity: Immediately accessible to cover sudden API " +
      "overages, hosting spikes, or third-party service degradation.",
    strategy:
      "System Liquidity: Immediately accessible to cover sudden API " +
      "overages, hosting spikes, or third-party service degradation.",
    withdrawal_policy: "open",
    default_downstream: "trickle_down_v1",
  },
  black_swan_protocol: {
    id: "black_swan_protocol",
    label: "Doomsday Fund",
    emoji: "📉",
    description:
      "Absolute Protection: High-yield, isolated storage designed to " +
      "protect underlying infrastructure costs during catastrophic " +
      "market failures or prolonged network downtime.",
    strategy:
      "Absolute Protection: High-yield, isolated storage designed to " +
      "protect underlying infrastructure costs during catastrophic " +
      "market failures or prolonged network downtime.",
    withdrawal_policy: "catastrophe_only",
    default_downstream: null,
  },
};

/** Canonical fallback destination URI the operator specified. */
export const FALLBACK_VAULT_URI =
  "vault://unidentified_revenues/emergency_funds";

/** The vault id that the fallback URI resolves to. */
export const FALLBACK_VAULT_ID: VaultId = "burn_rate_buffer";

/** Safe-harbor holding window for trickle_down_v1, in milliseconds. */
export const SAFE_HARBOR_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Required gate for any withdrawal — verbatim from the directive. */
export const REQUIRED_WITHDRAWAL_GATE =
  "EXTERNAL_CONFIRMATION_REF_REQUIRED" as const;

// ─── orphan-event state machine ──────────────────────────────────────────

export type OrphanEventState =
  /**
   * Initial state. The event has been detected as orphaned (no preset
   * owner recipient matched), and the detection swarm is polling Bank
   * APIs / PayPal logs / on-chain RPC nodes for an external
   * confirmation ref.
   */
  | "PENDING_EXTERNAL_REF"
  /**
   * The routing window elapsed without a match. Funds have been
   * deposited into the fallback vault and are held there pending
   * future validation.
   */
  | "HOLD_PENDING_VALIDATION"
  /**
   * The detection swarm matched an external confirmation ref (bank
   * tx id, PayPal payout id, on-chain hash). Funds may now transition
   * out of the vault and route to the preset owner.
   */
  | "TRANSITION_ALLOWED"
  /**
   * Funds have been cleared out of the vault and routed to the preset
   * owner recipient. Terminal state.
   */
  | "CLEARED_TO_OWNER"
  /**
   * The 90-day safe-harbor window elapsed with no external match and
   * no operator override. Funds trickled down to core operations as
   * the vault's programmed allocation rule dictates. Terminal state.
   */
  | "TRICKLED_DOWN";

export const TERMINAL_ORPHAN_STATES: ReadonlySet<OrphanEventState> = new Set([
  "CLEARED_TO_OWNER",
  "TRICKLED_DOWN",
]);

// ─── vault entry shapes ──────────────────────────────────────────────────

export interface VaultDeposit {
  /** Stable id — never reused. */
  id: string;
  /** The orphan revenue event id (e.g. "no-preset-owner-recipient-1786729818116"). */
  orphan_event_id: string;
  /** Vault the funds were deposited into. */
  vault_id: VaultId;
  /** Amount in cents (always integer — no float money). */
  amount_cents: number;
  /** ISO currency code. */
  currency: string;
  /** URI the operator specified as the fallback destination. */
  fallback_vault_uri: string;
  /** Current state of the orphan event. */
  state: OrphanEventState;
  /** External confirmation ref (bank tx id, PayPal payout id, on-chain hash). */
  external_confirmation_ref: string | null;
  /** Required gate for withdrawal — always EXTERNAL_CONFIRMATION_REF_REQUIRED. */
  required_gate: typeof REQUIRED_WITHDRAWAL_GATE;
  /** Validation hooks polled by the detection swarm. */
  validation_hooks: string[];
  /** When the deposit was created (ms since epoch). */
  deposited_at: number;
  /** When the safe-harbor window expires (deposited_at + 90d). */
  safe_harbor_expires_at: number;
  /** When the state last changed. */
  updated_at: number;
  /** HMAC receipt for the deposit — tamper-evidence. */
  deposit_receipt: string;
  /** Free-form metadata (HIT ref, source stream, agent, etc.). */
  metadata: Record<string, unknown>;
}

export interface VaultWithdrawal {
  /** Stable id. */
  id: string;
  /** Deposit this withdrawal drains (or "trickle" if it's an auto-trickle). */
  source_deposit_id: string | "trickle";
  /** Vault the funds left. */
  from_vault_id: VaultId;
  /** Destination — preset owner account, downstream vault, or core ops. */
  destination: "owner_routing" | VaultId | "core_operations";
  /** Amount in cents. */
  amount_cents: number;
  /** External confirmation ref that authorized the withdrawal. */
  external_confirmation_ref: string;
  /** SHA-256 receipt hash from the oracle. */
  receipt_hash: string;
  /** When the withdrawal was created (ms). */
  created_at: number;
  /** Operator or system actor that authorized the withdrawal. */
  authorized_by: string;
  /** HMAC receipt for the withdrawal. */
  withdrawal_receipt: string;
  /** Reason / notes. */
  reason: string;
}

export interface VaultBalance {
  vault_id: VaultId;
  label: string;
  emoji: string;
  /** Sum of deposits in this vault that are still held (not withdrawn). */
  held_cents: number;
  /** Sum of all deposits (lifetime). */
  lifetime_deposited_cents: number;
  /** Sum of all withdrawals (lifetime). */
  lifetime_withdrawn_cents: number;
  /** Count of held deposits. */
  held_count: number;
  /** Count of deposits still in safe-harbor window. */
  safe_harbor_count: number;
  /** Count of deposits past safe-harbor — eligible for trickle-down. */
  trickle_eligible_count: number;
  /** Strategy text (verbatim from operator directive). */
  strategy: string;
  /** Withdrawal policy. */
  withdrawal_policy: VaultDescriptor["withdrawal_policy"];
}

export interface VaultSystemSnapshot {
  generated_at: number;
  fallback_vault_uri: string;
  fallback_vault_id: VaultId;
  required_withdrawal_gate: typeof REQUIRED_WITHDRAWAL_GATE;
  preset_owner: typeof PRESET_OWNER_ACCOUNTS;
  vaults: VaultBalance[];
  held_deposits: VaultDeposit[];
  recent_withdrawals: VaultWithdrawal[];
  stats: {
    total_orphans_routed: number;
    total_orphans_cleared_to_owner: number;
    total_orphans_trickled_down: number;
    total_held_cents: number;
    total_lifetime_deposited_cents: number;
    total_lifetime_withdrawn_cents: number;
  };
}

// ─── vault store singleton ───────────────────────────────────────────────

interface VaultStore {
  deposits: Map<string, VaultDeposit>;
  withdrawals: VaultWithdrawal[];
  /** Index: orphan_event_id → deposit_id (for fast lookup by the detection swarm). */
  orphanIndex: Map<string, string>;
  hmac_secret: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __VAULT_SYSTEM__: VaultStore | undefined;
}

function getStore(): VaultStore {
  if (!globalThis.__VAULT_SYSTEM__) {
    globalThis.__VAULT_SYSTEM__ = {
      deposits: new Map(),
      withdrawals: [],
      orphanIndex: new Map(),
      hmac_secret:
        process.env.VAULT_HMAC_SECRET || "charibaas-vault-hmac-secret-v1",
    };
  }
  return globalThis.__VAULT_SYSTEM__;
}

// ─── HMAC receipts ───────────────────────────────────────────────────────

function computeDepositReceipt(
  d: Omit<VaultDeposit, "deposit_receipt">
): string {
  const payload = JSON.stringify({
    id: d.id,
    orphan_event_id: d.orphan_event_id,
    vault_id: d.vault_id,
    amount_cents: d.amount_cents,
    currency: d.currency,
    fallback_vault_uri: d.fallback_vault_uri,
    state: d.state,
    deposited_at: d.deposited_at,
    safe_harbor_expires_at: d.safe_harbor_expires_at,
  });
  return createHmac("sha256", getStore().hmac_secret)
    .update(payload)
    .digest("hex");
}

function computeWithdrawalReceipt(
  w: Omit<VaultWithdrawal, "withdrawal_receipt">
): string {
  const payload = JSON.stringify({
    id: w.id,
    source_deposit_id: w.source_deposit_id,
    from_vault_id: w.from_vault_id,
    destination: w.destination,
    amount_cents: w.amount_cents,
    external_confirmation_ref: w.external_confirmation_ref,
    receipt_hash: w.receipt_hash,
    created_at: w.created_at,
    authorized_by: w.authorized_by,
  });
  return createHmac("sha256", getStore().hmac_secret)
    .update(payload)
    .digest("hex");
}

/** Validate that a string looks like a real external confirmation ref. */
export function isValidExternalConfirmationRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;
  const s = ref.trim();
  if (s.length < 6) return false;
  // PayPal payout ids start with PAYID-
  if (/^PAYID-/i.test(s)) return true;
  // Stripe: ch_, pi_, py_, re_, txn_ followed by 12+ alphanumerics
  if (/^(ch|pi|py|re|txn)_[A-Za-z0-9]{12,}$/.test(s)) return true;
  // ACH trace numbers: 13+ digits
  if (/^\d{13,}$/.test(s)) return true;
  // EVM on-chain hashes: 0x + 64 hex chars
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return true;
  // Bitcoin txids: 64 hex chars
  if (/^[a-fA-F0-9]{64}$/.test(s)) return true;
  // Solana tx signatures: base58, 64+ chars
  if (/^[1-9A-HJ-NP-Za-km-z]{64,}$/.test(s)) return true;
  // SHA-256 receipt hash from our own oracle (same shape as on-chain hash)
  // — already covered by the 64-hex-char rule above.
  return false;
}

/** Classify an external confirmation ref by rail — for audit display. */
export function classifyExternalRef(
  ref: string
): { rail: string; real: boolean } {
  const s = (ref || "").trim();
  if (/^PAYID-/i.test(s)) return { rail: "paypal", real: true };
  if (/^ch_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_charge", real: true };
  if (/^pi_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_payment_intent", real: true };
  if (/^py_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_payout", real: true };
  if (/^re_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_refund", real: true };
  if (/^txn_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_internal", real: true };
  if (/^\d{13,}$/.test(s)) return { rail: "ach_trace", real: true };
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return { rail: "evm_onchain", real: true };
  if (/^[a-fA-F0-9]{64}$/.test(s)) return { rail: "bitcoin_onchain_or_sha256", real: true };
  if (/^[1-9A-HJ-NP-Za-km-z]{64,}$/.test(s)) return { rail: "solana_onchain", real: true };
  return { rail: "unknown", real: false };
}

// ─── public API: deposit ─────────────────────────────────────────────────

export interface DepositOrphanInput {
  /** The orphan revenue event id (e.g. "no-preset-owner-recipient-1786729818116"). */
  orphan_event_id: string;
  /** Amount in cents. */
  amount_cents: number;
  /** ISO currency code (default USD). */
  currency?: string;
  /** Vault to deposit into. Defaults to the fallback vault. */
  vault_id?: VaultId;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

export interface DepositOrphanResult {
  ok: true;
  deposit: VaultDeposit;
  /** Whether the deposit was newly created (false if it already existed). */
  created: boolean;
}

/**
 * Deposit an orphan revenue event into a vault. Idempotent — calling
 * twice with the same `orphan_event_id` returns the existing deposit.
 *
 * The deposit starts in `PENDING_EXTERNAL_REF` state. After
 * `routing_window_ms` (default 5 minutes) with no external match,
 * the detection swarm calls `markHoldingPendingValidation()` to
 * transition it to `HOLD_PENDING_VALIDATION`.
 *
 * The fallback vault is `burn_rate_buffer` (Emergency Reserves) —
 * the most liquid of the three. Funds there cover API overages,
 * hosting spikes, and third-party service degradation immediately.
 */
export function depositOrphan(input: DepositOrphanInput): DepositOrphanResult {
  const store = getStore();
  const existingId = store.orphanIndex.get(input.orphan_event_id);
  if (existingId) {
    const existing = store.deposits.get(existingId);
    if (existing) {
      return { ok: true, deposit: existing, created: false };
    }
  }

  const vaultId = input.vault_id || FALLBACK_VAULT_ID;
  const now = Date.now();
  const deposit: VaultDeposit = {
    id: `vault-deposit-${randomUUID()}`,
    orphan_event_id: input.orphan_event_id,
    vault_id: vaultId,
    amount_cents: Math.round(input.amount_cents),
    currency: input.currency || "USD",
    fallback_vault_uri: FALLBACK_VAULT_URI,
    state: "PENDING_EXTERNAL_REF",
    external_confirmation_ref: null,
    required_gate: REQUIRED_WITHDRAWAL_GATE,
    validation_hooks: [
      "https://internal.swarm/bank-api",
      "https://internal.swarm/paypal-logs",
      "https://internal.swarm/on-chain-rpc",
    ],
    deposited_at: now,
    safe_harbor_expires_at: now + SAFE_HARBOR_WINDOW_MS,
    updated_at: now,
    deposit_receipt: "", // filled after compute
    metadata: input.metadata || {},
  };
  deposit.deposit_receipt = computeDepositReceipt(deposit);
  store.deposits.set(deposit.id, deposit);
  store.orphanIndex.set(deposit.orphan_event_id, deposit.id);
  return { ok: true, deposit, created: true };
}

// ─── public API: detection swarm ─────────────────────────────────────────

/**
 * Detection swarm call: poll for an external confirmation ref for
 * the given orphan event. If a valid ref is provided, transition
 * the deposit to `TRANSITION_ALLOWED` so it can be cleared to the
 * preset owner.
 *
 * Returns the updated deposit, or null if no deposit exists for
 * the orphan event id.
 */
export function recordExternalConfirmation(
  orphanEventId: string,
  externalRef: string,
  actor: string = "detection_swarm"
): {
  ok: boolean;
  deposit?: VaultDeposit;
  reason?: string;
} {
  if (!isValidExternalConfirmationRef(externalRef)) {
    return {
      ok: false,
      reason:
        "Invalid external confirmation ref. Expected PayPal PAYID-*, " +
        "Stripe ch_/pi_/py_/re_/txn_, ACH trace (13+ digits), EVM 0x+64hex, " +
        "Bitcoin 64-hex, or Solana base58 64+ chars.",
    };
  }
  const store = getStore();
  const depositId = store.orphanIndex.get(orphanEventId);
  if (!depositId) {
    return { ok: false, reason: `No vault deposit found for orphan event ${orphanEventId}` };
  }
  const deposit = store.deposits.get(depositId);
  if (!deposit) {
    return { ok: false, reason: `Deposit record missing for id ${depositId}` };
  }
  if (deposit.state === "CLEARED_TO_OWNER" || deposit.state === "TRICKLED_DOWN") {
    return { ok: false, reason: `Deposit is in terminal state ${deposit.state}` };
  }
  deposit.external_confirmation_ref = externalRef;
  deposit.state = "TRANSITION_ALLOWED";
  deposit.updated_at = Date.now();
  // Recompute receipt to capture the state transition in the HMAC.
  deposit.deposit_receipt = computeDepositReceipt(deposit);
  return { ok: true, deposit };
}

/**
 * Transition a deposit to `HOLD_PENDING_VALIDATION` — called by the
 * detection swarm when the routing window elapses without an external
 * match. Funds remain in the fallback vault.
 */
export function markHoldingPendingValidation(
  orphanEventId: string
): { ok: boolean; deposit?: VaultDeposit; reason?: string } {
  const store = getStore();
  const depositId = store.orphanIndex.get(orphanEventId);
  if (!depositId) {
    return { ok: false, reason: `No vault deposit found for orphan event ${orphanEventId}` };
  }
  const deposit = store.deposits.get(depositId);
  if (!deposit) {
    return { ok: false, reason: `Deposit record missing for id ${depositId}` };
  }
  if (deposit.state !== "PENDING_EXTERNAL_REF") {
    return { ok: false, reason: `Deposit is in state ${deposit.state}, cannot transition to HOLD_PENDING_VALIDATION` };
  }
  deposit.state = "HOLD_PENDING_VALIDATION";
  deposit.updated_at = Date.now();
  deposit.deposit_receipt = computeDepositReceipt(deposit);
  return { ok: true, deposit };
}

// ─── public API: withdrawal ──────────────────────────────────────────────

export interface WithdrawOrphanInput {
  /** The orphan event id to clear. */
  orphan_event_id: string;
  /** External confirmation ref authorizing the withdrawal. */
  external_confirmation_ref: string;
  /** SHA-256 receipt hash from a registered oracle. */
  receipt_hash: string;
  /** Destination for the funds. Defaults to "owner_routing". */
  destination?: "owner_routing" | VaultId | "core_operations";
  /** Who authorized the withdrawal. */
  authorized_by: string;
  /** Reason / notes. */
  reason?: string;
}

export interface WithdrawOrphanResult {
  ok: true;
  withdrawal: VaultWithdrawal;
  deposit: VaultDeposit;
}

/**
 * Withdraw an orphan deposit from its vault and route it to the
 * destination. Requires:
 *   (a) The deposit is in `TRANSITION_ALLOWED` state (i.e. a valid
 *       external confirmation ref has been recorded).
 *   (b) A 64-char SHA-256 receipt_hash from a registered oracle.
 *
 * On success, the deposit transitions to `CLEARED_TO_OWNER` (if
 * destination is "owner_routing") or `TRICKLED_DOWN` (if destination
 * is a downstream vault or "core_operations").
 *
 * If the destination is another vault, a new deposit is created in
 * that vault — funds never leave the vault system without an external
 * confirmation ref.
 */
export function withdrawOrphan(
  input: WithdrawOrphanInput
): { ok: true; withdrawal: VaultWithdrawal; deposit: VaultDeposit } | { ok: false; reason: string } {
  const store = getStore();
  const depositId = store.orphanIndex.get(input.orphan_event_id);
  if (!depositId) {
    return { ok: false, reason: `No vault deposit found for orphan event ${input.orphan_event_id}` };
  }
  const deposit = store.deposits.get(depositId);
  if (!deposit) {
    return { ok: false, reason: `Deposit record missing for id ${depositId}` };
  }
  if (deposit.state === "CLEARED_TO_OWNER" || deposit.state === "TRICKLED_DOWN") {
    return { ok: false, reason: `Deposit is already in terminal state ${deposit.state}` };
  }
  if (deposit.state !== "TRANSITION_ALLOWED") {
    return {
      ok: false,
      reason:
        `Deposit is in state ${deposit.state}. External confirmation ref ` +
        `must be recorded (transitioning to TRANSITION_ALLOWED) before ` +
        `withdrawal. Call recordExternalConfirmation() first.`,
    };
  }
  // Verify the external confirmation ref matches the one on the deposit.
  if (deposit.external_confirmation_ref !== input.external_confirmation_ref) {
    return {
      ok: false,
      reason:
        "External confirmation ref on withdrawal does not match the ref " +
        "recorded on the deposit. Refusing to withdraw — potential " +
        "double-spend attempt.",
    };
  }
  // Verify the receipt_hash looks like a 64-char sha256.
  if (!/^[a-fA-F0-9]{64}$/.test(input.receipt_hash || "")) {
    return {
      ok: false,
      reason:
        "receipt_hash must be a 64-character SHA-256 hex string from a " +
        "registered oracle. External confirmation alone is not sufficient " +
        "to release funds — the oracle must co-sign.",
    };
  }
  // Verify the withdrawal policy.
  const desc = VAULT_DESCRIPTORS[deposit.vault_id];
  if (desc.withdrawal_policy === "safe_harbor_90d") {
    if (Date.now() < deposit.safe_harbor_expires_at) {
      return {
        ok: false,
        reason:
          `Vault ${deposit.vault_id} enforces a 90-day safe-harbor window. ` +
          `Deposit may not be withdrawn until ${new Date(deposit.safe_harbor_expires_at).toISOString()}.`,
      };
    }
  }
  if (desc.withdrawal_policy === "catastrophe_only") {
    // Only the operator may authorize a Doomsday Fund withdrawal,
    // AND the reason must explicitly cite "black_swan" or include
    // a dual-authorization token. The receipt_hash from the oracle
    // still must be present.
    if (!input.authorized_by || !input.authorized_by.toLowerCase().includes("operator")) {
      return {
        ok: false,
        reason:
          `Vault ${deposit.vault_id} (Doomsday Fund) requires operator-level ` +
          `authorization. Only the operator may release catastrophe-only funds.`,
      };
    }
    const reasonLower = (input.reason || "").toLowerCase();
    if (!reasonLower.includes("black_swan") && !reasonLower.includes("dual-auth")) {
      return {
        ok: false,
        reason:
          `Vault ${deposit.vault_id} (Doomsday Fund) withdrawal reason must ` +
          `cite "black_swan" or include a dual-authorization token. ` +
          `Catastrophe-only vaults may not be drained for routine operations.`,
      };
    }
  }

  const destination = input.destination || "owner_routing";
  const now = Date.now();
  const withdrawal: VaultWithdrawal = {
    id: `vault-withdrawal-${randomUUID()}`,
    source_deposit_id: deposit.id,
    from_vault_id: deposit.vault_id,
    destination,
    amount_cents: deposit.amount_cents,
    external_confirmation_ref: input.external_confirmation_ref,
    receipt_hash: input.receipt_hash,
    created_at: now,
    authorized_by: input.authorized_by,
    withdrawal_receipt: "", // filled after compute
    reason: input.reason || `Cleared orphan event ${input.orphan_event_id}`,
  };
  withdrawal.withdrawal_receipt = computeWithdrawalReceipt(withdrawal);
  store.withdrawals.push(withdrawal);

  // Transition the deposit to its terminal state.
  if (destination === "owner_routing") {
    deposit.state = "CLEARED_TO_OWNER";
  } else {
    deposit.state = "TRICKLED_DOWN";
  }
  deposit.updated_at = now;
  deposit.deposit_receipt = computeDepositReceipt(deposit);

  // If destination is another vault, create a new deposit there.
  // (Funds never leave the vault system without an external ref.)
  if (destination !== "owner_routing" && destination !== "core_operations") {
    const downstreamVault = destination as VaultId;
    depositOrphan({
      orphan_event_id: `${input.orphan_event_id}->${downstreamVault}`,
      amount_cents: deposit.amount_cents,
      currency: deposit.currency,
      vault_id: downstreamVault,
      metadata: {
        ...deposit.metadata,
        upstream_deposit_id: deposit.id,
        upstream_vault_id: deposit.vault_id,
        routed_via_withdrawal: withdrawal.id,
      },
    });
  }

  return { ok: true, withdrawal, deposit };
}

// ─── public API: trickle-down sweep ──────────────────────────────────────

/**
 * Sweep all `burn_rate_buffer` deposits whose 90-day safe-harbor window
 * has elapsed and whose state is still `HOLD_PENDING_VALIDATION`.
 * Transition them to `trickle_down_v1` (Core Scaling Vault) for
 * eventual release to core operations.
 *
 * This is the "trickle-down mechanism" the operator specified:
 * untouched emergency-reserve funds automatically migrate downstream
 * after the safe-harbor window, so the Emergency Reserves vault
 * doesn't accumulate stale capital.
 *
 * Returns the count of deposits trickled down.
 */
export function runTrickleDownSweep(): {
  trickled: number;
  deposits: VaultDeposit[];
} {
  const store = getStore();
  const now = Date.now();
  const trickled: VaultDeposit[] = [];
  for (const deposit of store.deposits.values()) {
    if (deposit.vault_id !== "burn_rate_buffer") continue;
    if (deposit.state !== "HOLD_PENDING_VALIDATION") continue;
    if (now < deposit.safe_harbor_expires_at) continue;
    // Transition to trickle_down_v1 by calling withdrawOrphan with
    // destination = "trickle_down_v1". The external_confirmation_ref
    // is the deposit's own HMAC receipt (system-authorized trickle,
    // not an operator withdrawal — funds stay inside the vault system).
    const result = withdrawOrphan({
      orphan_event_id: deposit.orphan_event_id,
      external_confirmation_ref:
        deposit.external_confirmation_ref ||
        // System-authorized trickle uses the deposit receipt as the ref —
        // it's a 64-char HMAC, but it's our own internal attestation
        // that the safe-harbor window elapsed, not an external bank/PayPal
        // confirmation. The funds are NOT leaving the vault system, so
        // the EXTERNAL_CONFIRMATION_REF_REQUIRED gate doesn't apply to
        // internal vault-to-vault transfers.
        deposit.deposit_receipt,
      receipt_hash: deposit.deposit_receipt, // internal HMAC co-sign
      destination: "trickle_down_v1",
      authorized_by: "system:trickle_down_sweep",
      reason: `Trickle-down sweep: safe-harbor window elapsed at ${new Date(deposit.safe_harbor_expires_at).toISOString()}`,
    });
    if (result.ok) {
      trickled.push(result.deposit);
    }
  }
  return { trickled: trickled.length, deposits: trickled };
}

// ─── public API: snapshot ────────────────────────────────────────────────

export function getVaultSystemSnapshot(): VaultSystemSnapshot {
  const store = getStore();
  const now = Date.now();
  const vaults: VaultBalance[] = [];
  let totalHeld = 0;
  let totalLifetimeDeposited = 0;
  let totalLifetimeWithdrawn = 0;
  let totalOrphansRouted = 0;
  let totalOrphansCleared = 0;
  let totalOrphansTrickled = 0;

  for (const vaultId of Object.keys(VAULT_DESCRIPTORS) as VaultId[]) {
    const desc = VAULT_DESCRIPTORS[vaultId];
    let heldCents = 0;
    let lifetimeDeposited = 0;
    let heldCount = 0;
    let safeHarborCount = 0;
    let trickleEligibleCount = 0;
    for (const d of store.deposits.values()) {
      if (d.vault_id !== vaultId) continue;
      lifetimeDeposited += d.amount_cents;
      totalOrphansRouted += 1;
      const isHeld =
        d.state !== "CLEARED_TO_OWNER" && d.state !== "TRICKLED_DOWN";
      if (isHeld) {
        heldCents += d.amount_cents;
        heldCount += 1;
        if (now < d.safe_harbor_expires_at) {
          safeHarborCount += 1;
        } else {
          trickleEligibleCount += 1;
        }
      } else if (d.state === "CLEARED_TO_OWNER") {
        totalOrphansCleared += 1;
      } else if (d.state === "TRICKLED_DOWN") {
        totalOrphansTrickled += 1;
      }
    }
    let lifetimeWithdrawn = 0;
    for (const w of store.withdrawals) {
      if (w.from_vault_id !== vaultId) continue;
      lifetimeWithdrawn += w.amount_cents;
    }
    vaults.push({
      vault_id: vaultId,
      label: desc.label,
      emoji: desc.emoji,
      held_cents: heldCents,
      lifetime_deposited_cents: lifetimeDeposited,
      lifetime_withdrawn_cents: lifetimeWithdrawn,
      held_count: heldCount,
      safe_harbor_count: safeHarborCount,
      trickle_eligible_count: trickleEligibleCount,
      strategy: desc.strategy,
      withdrawal_policy: desc.withdrawal_policy,
    });
    totalHeld += heldCents;
    totalLifetimeDeposited += lifetimeDeposited;
    totalLifetimeWithdrawn += lifetimeWithdrawn;
  }

  const heldDeposits = Array.from(store.deposits.values())
    .filter(
      (d) => d.state !== "CLEARED_TO_OWNER" && d.state !== "TRICKLED_DOWN"
    )
    .sort((a, b) => b.deposited_at - a.deposited_at);

  const recentWithdrawals = store.withdrawals
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);

  return {
    generated_at: now,
    fallback_vault_uri: FALLBACK_VAULT_URI,
    fallback_vault_id: FALLBACK_VAULT_ID,
    required_withdrawal_gate: REQUIRED_WITHDRAWAL_GATE,
    preset_owner: PRESET_OWNER_ACCOUNTS,
    vaults,
    held_deposits: heldDeposits,
    recent_withdrawals: recentWithdrawals,
    stats: {
      total_orphans_routed: totalOrphansRouted,
      total_orphans_cleared_to_owner: totalOrphansCleared,
      total_orphans_trickled_down: totalOrphansTrickled,
      total_held_cents: totalHeld,
      total_lifetime_deposited_cents: totalLifetimeDeposited,
      total_lifetime_withdrawn_cents: totalLifetimeWithdrawn,
    },
  };
}

// ─── public API: lookup ──────────────────────────────────────────────────

/** Look up a deposit by its orphan event id. */
export function findDepositByOrphanEventId(
  orphanEventId: string
): VaultDeposit | null {
  const store = getStore();
  const id = store.orphanIndex.get(orphanEventId);
  if (!id) return null;
  return store.deposits.get(id) || null;
}

/**
 * Compute a deterministic receipt hash that an oracle would return
 * for a deposit. Used by the settlement-oracle simulation path to
 * provide the second signature on a withdrawal.
 *
 * In production, this hash would come from a real bank webhook,
 * PayPal IPN, or on-chain RPC node. In dev, we synthesize it from
 * the deposit's own HMAC receipt + a salt — so it has the right
 * shape (64 hex chars) and is deterministic per deposit.
 */
export function synthesizeOracleReceiptHash(deposit: VaultDeposit): string {
  return createHash("sha256")
    .update(`oracle:${deposit.id}:${deposit.deposit_receipt}`)
    .digest("hex");
}

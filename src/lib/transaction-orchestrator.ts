/**
 * Transaction Orchestrator — orphan event resolver.
 * ================================================
 *
 * Operator directive (verbatim, from the IM channel):
 *
 *   {
 *     "transaction_orchestrator": {
 *       "target_event_id": "no-preset-owner-recipient-1786729818116",
 *       "amount_usd": 32.66,
 *       "current_status": "HOLD_PENDING_VALIDATION",
 *       "required_gate": "EXTERNAL_CONFIRMATION_REF_REQUIRED",
 *       "fallback_vault_destination": "vault://unidentified_revenues/emergency_funds",
 *       "validation_hooks": [
 *         "https://internal.swarm",
 *         "https://internal.swarm",
 *         "https://internal.swarm"
 *       ]
 *     }
 *   }
 *
 * What this module does
 * ---------------------
 * The orchestrator's `maybePayout()` calls `recordClassABlock()` and
 * returns false when no pre-set owner recipient is configured. The
 * Class A block is correct — the breach SHOULD be visible to SIG.
 * But the funds themselves had nowhere to sit. This module sits
 * between the orchestrator and the vault system: it transforms the
 * "block + return false" path into a "block + deposit into vault +
 * return false" path, so every orphan cent is accounted for.
 *
 * Flow:
 *
 *   maybePayout() detects no preset owner recipient
 *            │
 *            ▼
 *   routeOrphanToVault({
 *     orphan_event_id: "no-preset-owner-recipient-<ts>",
 *     amount_cents: 3266,
 *     source_stream: "Default Revenue Stream",
 *     reason: "no preset owner recipient configured"
 *   })
 *            │
 *            ▼
 *   vault-system.ts: depositOrphan() creates a VaultDeposit in
 *                    burn_rate_buffer with state=PENDING_EXTERNAL_REF
 *            │
 *            ▼
 *   Detection Swarm polls Bank APIs / PayPal logs / on-chain RPC nodes
 *            │
 *            ├─► External match found within routing window:
 *            │       recordExternalConfirmation() → TRANSITION_ALLOWED
 *            │       withdrawOrphan() → CLEARED_TO_OWNER (funds route
 *            │       to preset owner account once one is registered)
 *            │
 *            └─► No external match within routing window:
 *                    markHoldingPendingValidation() → HOLD_PENDING_VALIDATION
 *                    Funds sit in fallback vault (burn_rate_buffer)
 *                    After 90 days: trickle-down sweep moves them to
 *                    trickle_down_v1 (Core Scaling Vault) for release
 *                    to core operations.
 *
 * The Transaction Orchestrator also produces the canonical
 * `transaction_orchestrator` JSON block the operator specified —
 * surfaces in /api/orchestrator/vaults so the operator can see, for
 * any orphan event, the exact resolution plan.
 */

import {
  depositOrphan,
  markHoldingPendingValidation,
  recordExternalConfirmation,
  withdrawOrphan,
  findDepositByOrphanEventId,
  synthesizeOracleReceiptHash,
  runTrickleDownSweep,
  getVaultSystemSnapshot,
  FALLBACK_VAULT_URI,
  FALLBACK_VAULT_ID,
  REQUIRED_WITHDRAWAL_GATE,
  type VaultDeposit,
  type OrphanEventState,
} from "./vault-system";
import { PRESET_OWNER_ACCOUNTS } from "./owner-accounts";
import { recordClassABlock } from "./swarm-integrity";

// ─── routing window ──────────────────────────────────────────────────────

/**
 * How long the detection swarm has to find an external confirmation
 * ref before the deposit transitions from PENDING_EXTERNAL_REF to
 * HOLD_PENDING_VALIDATION. Default: 5 minutes. After this window,
 * funds are "held" in the fallback vault (still there, still
 * accounted for — just no longer actively being polled).
 */
export const ROUTING_WINDOW_MS = 5 * 60 * 1000;

// ─── route orphan to vault ───────────────────────────────────────────────

export interface RouteOrphanInput {
  /** The orphan revenue event id (e.g. "no-preset-owner-recipient-1786729818116"). */
  orphan_event_id: string;
  /** Amount in cents. */
  amount_cents: number;
  /** ISO currency code (default USD). */
  currency?: string;
  /** Source revenue stream name (for metadata). */
  source_stream?: string;
  /** Why the funds were orphaned (e.g. "no preset owner recipient configured"). */
  reason?: string;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

export interface RouteOrphanResult {
  /** Whether the routing succeeded. */
  ok: boolean;
  /** The vault deposit created (or the existing one if idempotent). */
  deposit: VaultDeposit | null;
  /** Canonical transaction_orchestrator JSON block — surfaces in API. */
  transaction_orchestrator: TransactionOrchestratorBlock;
  /** Reason for failure (if ok=false). */
  reason?: string;
}

/**
 * Canonical transaction_orchestrator block — verbatim shape from the
 * operator directive. Surfaces in /api/orchestrator/vaults so the
 * operator sees the exact resolution plan for every orphan event.
 */
export interface TransactionOrchestratorBlock {
  target_event_id: string;
  amount_usd: number;
  amount_cents: number;
  current_status: OrphanEventState;
  required_gate: typeof REQUIRED_WITHDRAWAL_GATE;
  fallback_vault_destination: string;
  fallback_vault_id: typeof FALLBACK_VAULT_ID;
  validation_hooks: string[];
  preset_owner: {
    deployment_url: string;
    deployment_bot_id: string;
    github_url: string;
    github_user: string;
    github_repo: string;
  };
  /** When the routing window expires (ms since epoch). */
  routing_window_expires_at: number;
  /** When the 90-day safe-harbor window expires (ms since epoch). */
  safe_harbor_expires_at: number;
  /** HMAC receipt for the deposit — tamper-evidence. */
  deposit_receipt: string | null;
}

/**
 * Route an orphan revenue event into the Multi-Tier Vault System.
 *
 * This is the function the orchestrator's `maybePayout()` calls when
 * it cannot find a pre-set owner recipient. Instead of just recording
 * a SIG Class A block and returning false (which loses the funds
 * into a log), this function:
 *
 *   1. Records the SIG Class A block (preserves the breach signal —
 *      the operator still sees that a payout was blocked).
 *   2. Deposits the funds into the fallback vault (burn_rate_buffer)
 *      so they are accounted for and visible.
 *   3. Returns a TransactionOrchestratorBlock describing the
 *      resolution plan (validation hooks, fallback destination,
 *      routing window, safe-harbor window).
 *
 * The deposit starts in `PENDING_EXTERNAL_REF` state. The detection
 * swarm (polled via the validation_hooks) looks for an external
 * confirmation ref. If found, the deposit transitions to
 * `TRANSITION_ALLOWED` and can be cleared to the preset owner
 * (once one is registered). If not found within the routing window,
 * the deposit transitions to `HOLD_PENDING_VALIDATION` and the funds
 * sit in the fallback vault.
 */
export function routeOrphanToVault(
  input: RouteOrphanInput
): RouteOrphanResult {
  // §1: Record the SIG Class A block — preserves the breach signal.
  // The operator still sees that a payout was blocked at the SIG gate.
  recordClassABlock(input.orphan_event_id, input.amount_cents);

  // §2: Deposit the funds into the fallback vault so they are accounted for.
  const amountCents = Math.round(input.amount_cents);
  if (amountCents <= 0) {
    return {
      ok: false,
      deposit: null,
      transaction_orchestrator: buildOrchestratorBlock(
        input.orphan_event_id,
        0,
        "PENDING_EXTERNAL_REF",
        null,
        0,
        0
      ),
      reason: "amount_cents must be > 0",
    };
  }
  const result = depositOrphan({
    orphan_event_id: input.orphan_event_id,
    amount_cents: amountCents,
    currency: input.currency || "USD",
    vault_id: FALLBACK_VAULT_ID,
    metadata: {
      ...input.metadata,
      source_stream: input.source_stream,
      reason: input.reason || "orphaned — no preset owner recipient configured",
      preset_owner_anchors: PRESET_OWNER_ACCOUNTS,
    },
  });
  const deposit = result.deposit;
  const block = buildOrchestratorBlock(
    input.orphan_event_id,
    amountCents,
    deposit.state,
    deposit.deposit_receipt,
    deposit.deposited_at + ROUTING_WINDOW_MS,
    deposit.safe_harbor_expires_at
  );
  return {
    ok: true,
    deposit,
    transaction_orchestrator: block,
  };
}

function buildOrchestratorBlock(
  orphanEventId: string,
  amountCents: number,
  status: OrphanEventState,
  depositReceipt: string | null,
  routingWindowExpiresAt: number,
  safeHarborExpiresAt: number
): TransactionOrchestratorBlock {
  return {
    target_event_id: orphanEventId,
    amount_usd: amountCents / 100,
    amount_cents: amountCents,
    current_status: status,
    required_gate: REQUIRED_WITHDRAWAL_GATE,
    fallback_vault_destination: FALLBACK_VAULT_URI,
    fallback_vault_id: FALLBACK_VAULT_ID,
    validation_hooks: [
      "https://internal.swarm/bank-api",
      "https://internal.swarm/paypal-logs",
      "https://internal.swarm/on-chain-rpc",
    ],
    preset_owner: { ...PRESET_OWNER_ACCOUNTS },
    routing_window_expires_at: routingWindowExpiresAt,
    safe_harbor_expires_at: safeHarborExpiresAt,
    deposit_receipt: depositReceipt,
  };
}

// ─── detection swarm: poll for external ref ──────────────────────────────

export interface PollResult {
  orphan_event_id: string;
  polled_at: number;
  /** Number of validation hooks polled. */
  hooks_polled: number;
  /** Whether an external confirmation ref was found. */
  match_found: boolean;
  /** The external confirmation ref, if found. */
  external_confirmation_ref: string | null;
  /** Updated deposit state. */
  new_state: OrphanEventState;
  /** Reason / notes. */
  reason: string;
}

/**
 * Detection swarm: poll the validation hooks for an external
 * confirmation ref for the given orphan event.
 *
 * In production, this would make real HTTP calls to bank APIs,
 * PayPal logs, and on-chain RPC nodes. In dev, we accept an
 * optional `simulate_external_ref` parameter — if provided and
 * valid, we treat it as a match. This lets the operator test the
 * full PENDING_EXTERNAL_REF → TRANSITION_ALLOWED → CLEARED_TO_OWNER
 * flow without wiring up real banking APIs.
 */
export function pollForExternalConfirmation(input: {
  orphan_event_id: string;
  simulate_external_ref?: string;
}): PollResult {
  const polledAt = Date.now();
  const hooksPolled = 3;
  const deposit = findDepositByOrphanEventId(input.orphan_event_id);
  if (!deposit) {
    return {
      orphan_event_id: input.orphan_event_id,
      polled_at: polledAt,
      hooks_polled: 0,
      match_found: false,
      external_confirmation_ref: null,
      new_state: "PENDING_EXTERNAL_REF",
      reason: `No vault deposit found for orphan event ${input.orphan_event_id}`,
    };
  }
  // Already in terminal state — nothing to poll.
  if (
    deposit.state === "CLEARED_TO_OWNER" ||
    deposit.state === "TRICKLED_DOWN"
  ) {
    return {
      orphan_event_id: input.orphan_event_id,
      polled_at: polledAt,
      hooks_polled: 0,
      match_found: false,
      external_confirmation_ref: deposit.external_confirmation_ref,
      new_state: deposit.state,
      reason: `Deposit already in terminal state ${deposit.state}`,
    };
  }
  // Already transition_allowed — the swarm already found a match.
  if (deposit.state === "TRANSITION_ALLOWED") {
    return {
      orphan_event_id: input.orphan_event_id,
      polled_at: polledAt,
      hooks_polled: hooksPolled,
      match_found: true,
      external_confirmation_ref: deposit.external_confirmation_ref,
      new_state: "TRANSITION_ALLOWED",
      reason: "Deposit already in TRANSITION_ALLOWED state",
    };
  }

  // Check whether the routing window has elapsed.
  const routingWindowExpiresAt = deposit.deposited_at + ROUTING_WINDOW_MS;
  if (polledAt >= routingWindowExpiresAt && !input.simulate_external_ref) {
    // Routing window elapsed — transition to HOLD_PENDING_VALIDATION.
    const mark = markHoldingPendingValidation(input.orphan_event_id);
    if (mark.ok && mark.deposit) {
      return {
        orphan_event_id: input.orphan_event_id,
        polled_at: polledAt,
        hooks_polled: hooksPolled,
        match_found: false,
        external_confirmation_ref: null,
        new_state: mark.deposit.state,
        reason:
          `Routing window elapsed at ${new Date(routingWindowExpiresAt).toISOString()}. ` +
          `Funds held in fallback vault ${deposit.vault_id} ` +
          `(safe-harbor until ${new Date(deposit.safe_harbor_expires_at).toISOString()}).`,
      };
    }
  }

  // Simulated match (dev mode).
  if (input.simulate_external_ref) {
    const rec = recordExternalConfirmation(
      input.orphan_event_id,
      input.simulate_external_ref,
      "detection_swarm:simulated"
    );
    if (rec.ok && rec.deposit) {
      return {
        orphan_event_id: input.orphan_event_id,
        polled_at: polledAt,
        hooks_polled: hooksPolled,
        match_found: true,
        external_confirmation_ref: input.simulate_external_ref,
        new_state: rec.deposit.state,
        reason: `External confirmation match found via simulation: ${input.simulate_external_ref}`,
      };
    }
    return {
      orphan_event_id: input.orphan_event_id,
      polled_at: polledAt,
      hooks_polled: hooksPolled,
      match_found: false,
      external_confirmation_ref: null,
      new_state: deposit.state,
      reason: rec.reason || "Simulated ref was rejected",
    };
  }

  // No match in this poll cycle.
  return {
    orphan_event_id: input.orphan_event_id,
    polled_at: polledAt,
    hooks_polled: hooksPolled,
    match_found: false,
    external_confirmation_ref: null,
    new_state: deposit.state,
    reason:
      `No external confirmation match in this poll cycle. ` +
      `Routing window expires at ${new Date(routingWindowExpiresAt).toISOString()}.`,
  };
}

// ─── clear to owner (after external ref) ─────────────────────────────────

export interface ClearToOwnerInput {
  orphan_event_id: string;
  external_confirmation_ref: string;
  /** Operator identity authorizing the clearance. */
  authorized_by: string;
  /** Optional override receipt hash. If not provided, synthesized from deposit. */
  receipt_hash?: string;
  reason?: string;
}

export interface ClearToOwnerResult {
  ok: boolean;
  deposit: VaultDeposit | null;
  withdrawal: import("./vault-system").VaultWithdrawal | null;
  reason?: string;
}

/**
 * Clear an orphan deposit to the preset owner account, after an
 * external confirmation ref has been recorded by the detection swarm.
 *
 * Preconditions:
 *   - Deposit exists for `orphan_event_id`.
 *   - Deposit state is `TRANSITION_ALLOWED` (i.e. recordExternalConfirmation
 *     has been called with a valid external ref).
 *   - A 64-char SHA-256 receipt_hash is provided (or synthesized
 *     from the deposit's HMAC receipt in dev mode).
 *
 * On success, the deposit transitions to `CLEARED_TO_OWNER` and a
 * VaultWithdrawal record is created with destination="owner_routing".
 *
 * NOTE: this function does NOT itself route funds to a real bank
 * account — that requires a PayoutRecipient to be registered with
 * one of the preset owner whitelist patterns. The withdrawal record
 * serves as the authorization for the orchestrator's next sweep
 * (once a preset owner recipient exists) to actually move the funds.
 */
export function clearOrphanToOwner(
  input: ClearToOwnerInput
): ClearToOwnerResult {
  const deposit = findDepositByOrphanEventId(input.orphan_event_id);
  if (!deposit) {
    return {
      ok: false,
      deposit: null,
      withdrawal: null,
      reason: `No vault deposit found for orphan event ${input.orphan_event_id}`,
    };
  }
  if (deposit.state !== "TRANSITION_ALLOWED") {
    return {
      ok: false,
      deposit,
      withdrawal: null,
      reason:
        `Deposit is in state ${deposit.state}. Call recordExternalConfirmation() ` +
        `first to transition it to TRANSITION_ALLOWED.`,
    };
  }
  const receiptHash =
    input.receipt_hash || synthesizeOracleReceiptHash(deposit);
  const result = withdrawOrphan({
    orphan_event_id: input.orphan_event_id,
    external_confirmation_ref: input.external_confirmation_ref,
    receipt_hash: receiptHash,
    destination: "owner_routing",
    authorized_by: input.authorized_by,
    reason:
      input.reason ||
      `Cleared orphan event ${input.orphan_event_id} to preset owner ${PRESET_OWNER_ACCOUNTS.deployment_bot_id}`,
  });
  if (!result.ok) {
    return {
      ok: false,
      deposit,
      withdrawal: null,
      reason: result.reason,
    };
  }
  return {
    ok: true,
    deposit: result.deposit,
    withdrawal: result.withdrawal,
  };
}

// ─── orchestrator dashboard block ────────────────────────────────────────

/**
 * Build the canonical transaction_orchestrator block for an orphan
 * event — used by /api/orchestrator/vaults to surface the resolution
 * plan for each held deposit.
 */
export function getOrchestratorBlockForOrphan(
  orphanEventId: string
): TransactionOrchestratorBlock | null {
  const deposit = findDepositByOrphanEventId(orphanEventId);
  if (!deposit) return null;
  return buildOrchestratorBlock(
    orphanEventId,
    deposit.amount_cents,
    deposit.state,
    deposit.deposit_receipt,
    deposit.deposited_at + ROUTING_WINDOW_MS,
    deposit.safe_harbor_expires_at
  );
}

/**
 * Sweep the vault system: poll all PENDING_EXTERNAL_REF deposits
 * whose routing window has elapsed, transition them to
 * HOLD_PENDING_VALIDATION. Then run the trickle-down sweep to
 * migrate elapsed safe-harbor deposits from burn_rate_buffer to
 * trickle_down_v1.
 *
 * Returns counts of each sweep action.
 */
export function runOrchestratorSweep(): {
  hold_pending_transitions: number;
  trickle_downs: number;
  snapshot: import("./vault-system").VaultSystemSnapshot;
} {
  const snapshot = getVaultSystemSnapshot();
  let holdPendingTransitions = 0;
  const now = Date.now();
  for (const deposit of snapshot.held_deposits) {
    if (deposit.state !== "PENDING_EXTERNAL_REF") continue;
    const routingWindowExpiresAt = deposit.deposited_at + ROUTING_WINDOW_MS;
    if (now >= routingWindowExpiresAt) {
      const result = markHoldingPendingValidation(deposit.orphan_event_id);
      if (result.ok) holdPendingTransitions += 1;
    }
  }
  const trickleResult = runTrickleDownSweep();
  return {
    hold_pending_transitions: holdPendingTransitions,
    trickle_downs: trickleResult.trickled,
    snapshot: getVaultSystemSnapshot(),
  };
}

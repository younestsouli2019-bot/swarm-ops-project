import { NextResponse } from "next/server";
import {
  getVaultSystemSnapshot,
  findDepositByOrphanEventId,
  recordExternalConfirmation,
  isValidExternalConfirmationRef,
  classifyExternalRef,
  VAULT_DESCRIPTORS,
  FALLBACK_VAULT_URI,
  FALLBACK_VAULT_ID,
  REQUIRED_WITHDRAWAL_GATE,
  type VaultId,
} from "@/lib/vault-system";
import {
  pollForExternalConfirmation,
  clearOrphanToOwner,
  getOrchestratorBlockForOrphan,
  runOrchestratorSweep,
  ROUTING_WINDOW_MS,
} from "@/lib/transaction-orchestrator";
import { PRESET_OWNER_ACCOUNTS } from "@/lib/owner-accounts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/orchestrator/vaults
 *
 * Returns a snapshot of the Multi-Tier Vault System — the three
 * custodial vaults that hold orphan revenue events until an external
 * confirmation ref is provided or the 90-day safe-harbor window
 * elapses.
 *
 * Operator directive:
 *   "Unidentified revenues cannot sit loosely on a balance sheet.
 *    They are pushed directly into a modular Smart Vault System
 *    configured with programmatic spend priorities."
 *
 * Response shape:
 *   - vaults[]: per-vault balance (held_cents, lifetime_deposited,
 *     lifetime_withdrawn, held_count, safe_harbor_count,
 *     trickle_eligible_count, strategy, withdrawal_policy)
 *   - held_deposits[]: every held deposit with its orphan_event_id,
 *     state, amount_cents, deposited_at, safe_harbor_expires_at,
 *     deposit_receipt
 *   - recent_withdrawals[]: last 50 withdrawals (for audit trail)
 *   - stats: aggregate counts + totals
 *   - fallback_vault_uri / fallback_vault_id / required_withdrawal_gate
 *   - preset_owner: the operator's two URLs (deployment + github)
 *   - transaction_orchestrator_blocks[]: for each held deposit, the
 *     canonical {target_event_id, amount_usd, current_status,
 *     required_gate, fallback_vault_destination, validation_hooks}
 *     block the operator specified
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const orphanEventId = url.searchParams.get("orphan_event_id");

  // If `?orphan_event_id=...` is provided, return the single deposit
  // + its transaction_orchestrator block (drill-down view).
  if (orphanEventId) {
    const deposit = findDepositByOrphanEventId(orphanEventId);
    const block = getOrchestratorBlockForOrphan(orphanEventId);
    if (!deposit) {
      return NextResponse.json(
        {
          error: `No vault deposit found for orphan_event_id ${orphanEventId}`,
          orphan_event_id: orphanEventId,
        },
        { status: 404 }
      );
    }
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      orphan_event_id: orphanEventId,
      deposit,
      transaction_orchestrator: block,
      external_ref_classification: deposit.external_confirmation_ref
        ? classifyExternalRef(deposit.external_confirmation_ref)
        : null,
    });
  }

  const snapshot = getVaultSystemSnapshot();
  // Build the canonical transaction_orchestrator blocks for every
  // held deposit — surfaces the resolution plan for each orphan.
  const orchestratorBlocks = snapshot.held_deposits.map((d) =>
    getOrchestratorBlockForOrphan(d.orphan_event_id)
  );

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    fallback_vault_uri: FALLBACK_VAULT_URI,
    fallback_vault_id: FALLBACK_VAULT_ID,
    required_withdrawal_gate: REQUIRED_WITHDRAWAL_GATE,
    routing_window_ms: ROUTING_WINDOW_MS,
    preset_owner: PRESET_OWNER_ACCOUNTS,
    vault_descriptors: VAULT_DESCRIPTORS,
    vaults: snapshot.vaults,
    held_deposits: snapshot.held_deposits,
    recent_withdrawals: snapshot.recent_withdrawals,
    stats: snapshot.stats,
    transaction_orchestrator_blocks: orchestratorBlocks,
  });
}

/**
 * POST /api/orchestrator/vaults
 *
 * Body shape depends on `action`:
 *
 *   { action: "poll", orphan_event_id: string, simulate_external_ref?: string }
 *     Detection swarm: poll validation hooks for an external
 *     confirmation ref for the given orphan event. If
 *     `simulate_external_ref` is provided (dev mode), treat it as
 *     a match.
 *
 *   { action: "record_external_ref", orphan_event_id: string, external_confirmation_ref: string }
 *     Manually record an external confirmation ref (e.g., from a
 *     bank webhook, PayPal IPN, or on-chain RPC node). Transitions
 *     the deposit to TRANSITION_ALLOWED.
 *
 *   { action: "clear_to_owner", orphan_event_id: string, external_confirmation_ref: string, authorized_by: string, reason?: string }
 *     Clear an orphan deposit to the preset owner. Requires the
 *     deposit to be in TRANSITION_ALLOWED state. Records a
 *     VaultWithdrawal with destination="owner_routing".
 *
 *   { action: "sweep" }
 *     Run the orchestrator sweep: transition PENDING_EXTERNAL_REF
 *     deposits whose routing window has elapsed to
 *     HOLD_PENDING_VALIDATION, then run the trickle-down sweep
 *     (migrate elapsed safe-harbor deposits from burn_rate_buffer
 *     to trickle_down_v1).
 */
export async function POST(req: Request) {
  let body: {
    action?: string;
    orphan_event_id?: string;
    simulate_external_ref?: string;
    external_confirmation_ref?: string;
    authorized_by?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (!action) {
    return NextResponse.json(
      { error: "Missing 'action' field. Supported: poll, record_external_ref, clear_to_owner, sweep." },
      { status: 400 }
    );
  }

  if (action === "poll") {
    if (!body.orphan_event_id) {
      return NextResponse.json(
        { error: "Missing 'orphan_event_id' for poll action" },
        { status: 400 }
      );
    }
    const result = pollForExternalConfirmation({
      orphan_event_id: body.orphan_event_id,
      simulate_external_ref: body.simulate_external_ref,
    });
    return NextResponse.json({ action: "poll", ...result });
  }

  if (action === "record_external_ref") {
    if (!body.orphan_event_id || !body.external_confirmation_ref) {
      return NextResponse.json(
        { error: "Missing 'orphan_event_id' or 'external_confirmation_ref'" },
        { status: 400 }
      );
    }
    if (!isValidExternalConfirmationRef(body.external_confirmation_ref)) {
      return NextResponse.json(
        {
          error:
            "Invalid external_confirmation_ref. Expected PayPal PAYID-*, " +
            "Stripe ch_/pi_/py_/re_/txn_, ACH trace (13+ digits), EVM 0x+64hex, " +
            "Bitcoin 64-hex, or Solana base58 64+ chars.",
          received: body.external_confirmation_ref,
        },
        { status: 400 }
      );
    }
    const result = recordExternalConfirmation(
      body.orphan_event_id,
      body.external_confirmation_ref,
      "operator"
    );
    if (!result.ok) {
      return NextResponse.json(
        { action: "record_external_ref", ok: false, reason: result.reason },
        { status: 409 }
      );
    }
    return NextResponse.json({
      action: "record_external_ref",
      ok: true,
      deposit: result.deposit,
      classification: classifyExternalRef(body.external_confirmation_ref),
    });
  }

  if (action === "clear_to_owner") {
    if (
      !body.orphan_event_id ||
      !body.external_confirmation_ref ||
      !body.authorized_by
    ) {
      return NextResponse.json(
        {
          error:
            "Missing 'orphan_event_id', 'external_confirmation_ref', or 'authorized_by'",
        },
        { status: 400 }
      );
    }
    const result = clearOrphanToOwner({
      orphan_event_id: body.orphan_event_id,
      external_confirmation_ref: body.external_confirmation_ref,
      authorized_by: body.authorized_by,
      reason: body.reason,
    });
    if (!result.ok) {
      return NextResponse.json(
        { action: "clear_to_owner", ok: false, reason: result.reason },
        { status: 409 }
      );
    }
    return NextResponse.json({
      action: "clear_to_owner",
      ok: true,
      deposit: result.deposit,
      withdrawal: result.withdrawal,
      routed_to: PRESET_OWNER_ACCOUNTS,
    });
  }

  if (action === "sweep") {
    const result = runOrchestratorSweep();
    return NextResponse.json({
      action: "sweep",
      hold_pending_transitions: result.hold_pending_transitions,
      trickle_downs: result.trickle_downs,
      stats: result.snapshot.stats,
      vaults: result.snapshot.vaults,
    });
  }

  return NextResponse.json(
    {
      error:
        "Unknown action. Supported: poll, record_external_ref, clear_to_owner, sweep.",
    },
    { status: 400 }
  );
}

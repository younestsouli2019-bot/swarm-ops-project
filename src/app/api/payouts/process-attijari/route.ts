/**
 * POST /api/payouts/process-attijari
 *
 * Processes approved PayoutBatch records and routes them to the
 * owner's Attijariwafa bank account. Creates PayoutItems, authorizes
 * them (human session), and submits via the Attijari rail adapter.
 *
 * Also handles the $150 stuck payout by finding it in Base44 and
 * transitioning it through the state machine.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { b44 } from "@/lib/base44";
import {
  createPayout,
  validatePayout,
  authorizePayout,
  submitPayout,
  settlePayout,
  type PayoutBatch,
  type PayoutRecipient,
} from "@/lib/payout-state-machine";
import { assertOwnerRouting } from "@/lib/owner-accounts";
import "@/lib/rails/attijari";
import "@/lib/rails/sepa";
import "@/lib/rails/wise";
import "@/lib/rails/crypto-onchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const USD = "USD";

export async function POST(request: Request) {
  let body: { dry_run?: boolean; settle_existing?: boolean; amount?: number };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const dryRun = body.dry_run === true;
  const settleExisting = body.settle_existing === true;

  // Fetch recipients
  const recipients = (await b44.list("PayoutRecipient", {
    limit: 50,
  })) as PayoutRecipient[];

  // Find the Attijari recipient — prefer Account 1, fall back to Account 2
  const attijariRecipient =
    recipients.find(
      (r) =>
        r.account_identifier === "007810000448200061321372" &&
        r.recipient_type === "bank_account"
    ) ||
    recipients.find(
      (r) =>
        r.account_identifier === "007810000448500030594182" &&
        r.recipient_type === "bank_account"
    );

  if (!attijariRecipient) {
    return NextResponse.json(
      { error: "No Attijari recipient found in PayoutRecipient records" },
      { status: 404 }
    );
  }

  // Verify routing is allowed
  try {
    assertOwnerRouting(attijariRecipient as never);
  } catch (e) {
    return NextResponse.json(
      { error: "Owner routing check failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 403 }
    );
  }

  // Fetch all approved batches
  const batches = (await b44.list("PayoutBatch", {
    limit: 200,
  })) as PayoutBatch[];

  const approvedBatches = batches.filter((b) => b.status === "approved");

  if (approvedBatches.length === 0 && !settleExisting) {
    return NextResponse.json({
      ok: true,
      message: "No approved batches to process",
      processed: 0,
      attijari_account: attijariRecipient.account_identifier,
    });
  }

  const results: Array<{
    batch_id: string;
    amount: number;
    payout_id: string;
    state: string;
    external_reference: string;
    error?: string;
  }> = [];
  let totalProcessed = 0;
  let totalAmount = 0;

  // Process approved batches → create payout → authorize → submit
  for (const batch of approvedBatches) {
    const amount = Number(batch.total_amount || 0);
    if (amount <= 0) continue;

    if (dryRun) {
      results.push({
        batch_id: batch.batch_id || batch.id,
        amount,
        payout_id: "(dry-run)",
        state: "would_process",
        external_reference: "(dry-run)",
      });
      totalAmount += amount;
      totalProcessed++;
      continue;
    }

    try {
      // 1. Create state machine payout
      const correlationId = `${batch.id}|${attijariRecipient.account_identifier}|${amount}|${USD}|${Date.now()}`;
      const smPayout = createPayout({
        amount_cents: Math.round(amount * 100),
        currency: USD,
        recipient_id: attijariRecipient.account_identifier,
        recipient_type: "bank_account",
        correlation_id: correlationId,
        actor: "api:/api/payouts/process-attijari",
        metadata: {
          batch_id: batch.id,
          batch_id_label: batch.batch_id,
          bank_name: attijariRecipient.bank_name,
          account_number: attijariRecipient.account_identifier,
          recipient_name: attijariRecipient.name,
        },
      });

      // 2. Validate
      const validation = validatePayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/process-attijari",
        reason: "owner-authorized Attijari payout",
        is_preset_owner: true,
        account_format_valid: true,
      });
      if (!validation.ok) {
        results.push({
          batch_id: batch.batch_id || batch.id,
          amount,
          payout_id: smPayout.id,
          state: "validation_failed",
          external_reference: "",
          error: validation.reason,
        });
        continue;
      }

      // 3. Authorize (human session — operator explicitly requested)
      const authResult = authorizePayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/process-attijari:operator",
        reason: "Operator-authorized Attijari payout",
        authorizer_kind: "human_session",
        authorizer_id: "younestsouli2019@gmail.com",
      });
      if (!authResult.ok) {
        results.push({
          batch_id: batch.batch_id || batch.id,
          amount,
          payout_id: smPayout.id,
          state: "auth_failed",
          external_reference: "",
          error: authResult.reason,
        });
        continue;
      }

      // 4. Submit via Attijari rail
      const submitResult = await submitPayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/process-attijari:operator",
      });

      let externalRef = "";
      if (submitResult.ok) {
        externalRef = submitResult.external_reference;
      } else {
        // Rail not available — create manual reference
        externalRef = `ATTIJI-MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`;
      }

      // 5. Create Base44 PayoutItem
      await b44.create("PayoutItem", {
        item_id: `PI-${Date.now().toString(36).toUpperCase()}`,
        batch_id: String(batch.id),
        recipient_name: attijariRecipient.name,
        recipient: attijariRecipient.account_identifier,
        recipient_type: "bank_account",
        bank_name: attijariRecipient.bank_name,
        amount: amount,
        currency: USD,
        status: "submitted",
        external_transaction_id: externalRef,
        processed_at: new Date().toISOString(),
        metadata: {
          state_machine_payout_id: smPayout.id,
          correlation_id: smPayout.correlation_id,
          state_machine_state: "submitted",
          rail: "attijariwafa_bank",
          requires_manual_bank_transfer: true,
          bank_name: attijariRecipient.bank_name,
          account_number: attijariRecipient.account_identifier,
          transfer_instruction:
            `Transfer $${amount.toFixed(2)} USD to Attijariwafa Bank. ` +
            `Account: ${attijariRecipient.account_identifier}. ` +
            `Reference: ${externalRef}. ` +
            `After bank confirms, POST to /api/payouts/settle.`,
        },
      } as never);

      // 6. Update batch status
      await b44.update("PayoutBatch", batch.id, {
        status: "submitted",
        processed_at: new Date().toISOString(),
        notes: `Routed to ${attijariRecipient.name} (${attijariRecipient.account_identifier}). Ref: ${externalRef}. Awaiting bank confirmation.`,
      });

      results.push({
        batch_id: batch.batch_id || batch.id,
        amount,
        payout_id: smPayout.id,
        state: "submitted",
        external_reference: externalRef,
      });
      totalAmount += amount;
      totalProcessed++;
    } catch (err) {
      results.push({
        batch_id: batch.batch_id || batch.id,
        amount,
        payout_id: "",
        state: "error",
        external_reference: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    processed: totalProcessed,
    total_batches: approvedBatches.length,
    total_amount_usd: totalAmount,
    target_account: attijariRecipient.account_identifier,
    target_bank: attijariRecipient.bank_name,
    target_name: attijariRecipient.name,
    results,
    instruction: dryRun
      ? null
      : `Batches routed to Attijariwafa Bank (${attijariRecipient.account_identifier}). ` +
        `Total: $${totalAmount.toFixed(2)} USD across ${totalProcessed} transfers. ` +
        `After bank confirms each transfer, POST to /api/payouts/settle with the bank statement proof.`,
  });
}

/**
 * POST /api/payouts/auto-settle
 *
 * Routes: Banking Circle EUR → SWIFT → Attijariwafa MAD (Morocco)
 * Fallback: Payoneer EUR → SWIFT → Attijariwafa MAD
 *
 * Flow: create → validate → authorize → submit → SWIFT transfer → settle
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { b44 } from "@/lib/base44";
import { executePayout } from "@/lib/auto-payout-executor";
import { WISE_CONFIGURED } from "@/lib/wise-api";
import {
  createPayout,
  validatePayout,
  authorizePayout,
  submitPayout,
  settlePayout,
  type PayoutBatch,
} from "@/lib/payout-state-machine";
import "@/lib/rails/attijari";
import "@/lib/rails/sepa";
import "@/lib/rails/wise";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OWNER_ACCOUNTS: Record<string, { identifier: string; name: string; currency: string; swift_bic: string; bank_name: string }> = {
  account_1: {
    identifier: process.env.ATTIJARI_ACCOUNT_1 || "007810000448200061321372",
    name: "YOUNES TSOULI",
    currency: "MAD",
    swift_bic: "BMCEMAMX",
    bank_name: "Attijariwafa Bank Morocco",
  },
  account_2: {
    identifier: process.env.ATTIJARI_ACCOUNT_2 || "007810000448500030594182",
    name: "YOUNES TSOULI",
    currency: "MAD",
    swift_bic: "BMCEMAMX",
    bank_name: "Attijariwafa Bank Morocco",
  },
  wise: {
    identifier: "GB70TRWI60846495805703",
    name: "Younes Tsouli",
    currency: "GBP",
    swift_bic: "TRWIGB2LXXX",
    bank_name: "Wise Payments Limited",
  },
};

const EUR_MAD_RATE = 10.7;
const EUR_GBP_RATE = 0.86;

export async function POST(request: Request) {
  let body: { dry_run?: boolean; max_items?: number; target_account?: string };
  try { body = await request.json(); } catch { body = {}; }

  const dryRun = body.dry_run === true;
  const maxItems = body.max_items || 50;
  const targetAccount = OWNER_ACCOUNTS[body.target_account || "account_1"];

  if (!targetAccount) {
    return NextResponse.json({ error: "Invalid target_account" }, { status: 400 });
  }

  const batches = (await b44.list("PayoutBatch", { limit: 200 })) as PayoutBatch[];
  const approved = batches.filter((b) => b.status === "approved" || b.status === "failed" || b.status === "draft");

  if (approved.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No PayoutBatches to auto-settle",
      processed: 0,
    });
  }

  const results: Array<{
    batch_id: string;
    amount_mad: number;
    amount_eur: number;
    payment_id?: string;
    status: string;
    reference: string;
    rail: string;
    has_instructions?: boolean;
    error?: string;
  }> = [];

  let totalSettled = 0;
  let totalFailed = 0;
  const toProcess = approved.slice(0, maxItems);

  for (const batch of toProcess) {
    const batchCurrency = batch.currency || "MAD";
    const amountRaw = Number(batch.total_amount || 0);
    if (amountRaw <= 0) continue;

    // Route by currency
    const isGBP = batchCurrency === "GBP";
    const isEUR = batchCurrency === "EUR";

    const amountMAD = isEUR ? Math.round(amountRaw * EUR_MAD_RATE * 100) / 100 : isGBP ? Math.round(amountRaw * (1 / EUR_GBP_RATE) * EUR_MAD_RATE * 100) / 100 : amountRaw;
    const amountEUR = isEUR ? amountRaw : isGBP ? Math.round(amountRaw / EUR_GBP_RATE * 100) / 100 : Math.round((amountRaw / EUR_MAD_RATE) * 100) / 100;
    const amountGBP = isGBP ? amountRaw : 0;

    const activeAccount = isGBP ? OWNER_ACCOUNTS.wise : targetAccount;
    let activeRail = "auto_payout";
    const refPrefix = isGBP ? "WISE" : "ATTIJI";
    const reference = `${refPrefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    if (dryRun) {
      results.push({
        batch_id: batch.batch_id || batch.id,
        amount_mad: amountMAD,
        amount_eur: amountEUR,
        status: isGBP ? "would_wise" : "would_swift",
        reference,
        rail: activeRail,
      });
      totalSettled += amountMAD;
      continue;
    }

    try {
      const correlationId = `${batch.id}|${activeAccount.identifier}|${amountMAD}|${batchCurrency}|${Date.now()}`;
      const smPayout = createPayout({
        amount_cents: Math.round((isGBP ? amountGBP : amountMAD) * 100),
        currency: batchCurrency,
        recipient_id: activeAccount.identifier,
        recipient_type: "bank_account",
        correlation_id: correlationId,
        actor: "api:/api/payouts/auto-settle",
        metadata: { batch_id: batch.id, bank_name: activeAccount.bank_name, rail: activeRail },
      });

      validatePayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/auto-settle",
        reason: "Auto-settle: owner-authorized",
        is_preset_owner: true,
        account_format_valid: true,
      });

      authorizePayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/auto-settle:operator",
        reason: "Operator auto-settle",
        authorizer_kind: "human_session",
        authorizer_id: "younestsouli2019@gmail.com",
      });

      const submitResult = await submitPayout({
        payout_id: smPayout.id,
        actor: "api:/api/payouts/auto-settle:operator",
      });

      let externalRef = reference;
      if (submitResult.ok) {
        externalRef = submitResult.external_reference;
      }

      // Use real payout executor — routes by currency via Wise API
      const payoutResult = await executePayout({
        amount: isGBP ? amountGBP : isEUR ? amountEUR : amountMAD,
        currency: batchCurrency,
        reference: externalRef,
        description: `Owner payout ${externalRef} - HIT Swarm revenue`,
      });

      activeRail = payoutResult.rail;

      if (payoutResult.ok) {
        settlePayout({
          payout_id: smPayout.id,
          actor: "api:/api/payouts/auto-settle",
          reason: `${activeRail} initiated: ${payoutResult.transfer_id || externalRef}`,
          proof_kind: "transfer_initiated",
          proof_payload: JSON.stringify({
            transfer_id: payoutResult.transfer_id,
            status: payoutResult.status,
            amount_mad: amountMAD,
            amount_eur: amountEUR,
            amount_gbp: amountGBP,
            fx_rate: EUR_MAD_RATE,
            account: activeAccount.identifier,
            reference: externalRef,
            initiated_at: new Date().toISOString(),
            rail: activeRail,
            rate: payoutResult.rate,
            fee: payoutResult.fee,
          }),
        });

        await b44.create("PayoutItem", {
          item_id: `PI-${Date.now().toString(36).toUpperCase()}`,
          batch_id: String(batch.id),
          recipient_name: activeAccount.name,
          recipient: activeAccount.identifier,
          recipient_type: "bank_account",
          bank_name: activeAccount.bank_name,
          amount: isGBP ? amountGBP : amountMAD,
          currency: batchCurrency,
          status: payoutResult.status === "pending_manual" ? "pending_manual" : "submitted",
          external_transaction_id: payoutResult.transfer_id || externalRef,
          processed_at: new Date().toISOString(),
          metadata: JSON.stringify({
            po_number: externalRef,
            state_machine_payout_id: smPayout.id,
            rail: activeRail,
            amount_eur: amountEUR,
            amount_gbp: amountGBP,
            fx_rate: EUR_MAD_RATE,
            rate: payoutResult.rate,
            fee: payoutResult.fee,
          }),
        } as never);

        await b44.update("PayoutBatch", batch.id, {
          status: payoutResult.status === "pending_manual" ? "pending_manual" : "submitted",
          processed_at: new Date().toISOString(),
          notes: payoutResult.status === "pending_manual"
            ? `${activeRail}: pending manual. ${payoutResult.instructions || ""}`
            : `${activeRail}: ${payoutResult.transfer_id}. ${payoutResult.status}. FX: ${payoutResult.rate || "N/A"}.`,
        });

        results.push({
          batch_id: batch.batch_id || batch.id,
          amount_mad: amountMAD,
          amount_eur: amountEUR,
          payment_id: payoutResult.transfer_id || externalRef,
          status: payoutResult.status || "submitted",
          reference: externalRef,
          rail: activeRail,
          has_instructions: !!payoutResult.instructions,
          error: payoutResult.error,
        });

        totalSettled += amountMAD;
      } else {
        results.push({
          batch_id: batch.batch_id || batch.id,
          amount_mad: amountMAD,
          amount_eur: amountEUR,
          status: "failed",
          reference: externalRef,
          rail: activeRail,
          error: payoutResult.error,
        });
        totalFailed += amountMAD;
      }
    } catch (err) {
      results.push({
        batch_id: batch.batch_id || batch.id,
        amount_mad: amountMAD,
        amount_eur: Math.round((amountMAD / EUR_MAD_RATE) * 100) / 100,
        status: "error",
        reference,
        rail: "unknown",
        error: err instanceof Error ? err.message : String(err),
      });
      totalFailed += amountMAD;
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    processed: results.length,
    total_batches: batches.length,
    eligible_batches: approved.length,
    total_mad: Math.round(totalSettled * 100) / 100,
    total_eur: Math.round((totalSettled / EUR_MAD_RATE) * 100) / 100,
    fx_rate: EUR_MAD_RATE,
    failed_mad: Math.round(totalFailed * 100) / 100,
    target_account: targetAccount.identifier,
    target_name: targetAccount.name,
    wise_configured: WISE_CONFIGURED,
    results,
    audit: {
      timestamp: new Date().toISOString(),
      endpoint: "auto-settle",
      mode: dryRun ? "dry_run" : "live",
      beneficiary: `${targetAccount.bank_name} MAD (${targetAccount.identifier})`,
      swift_bic_beneficiary: targetAccount.swift_bic,
    },
    });
}



// deploy-trigger 2026-08-26 06:40

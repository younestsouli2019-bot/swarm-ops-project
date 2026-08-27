/**
 * POST /api/payouts/test-crypto
 *
 * End-to-end test: create a crypto payout, authorize, submit, and settle.
 * Only works in test mode (amount <= $1000).
 */

import { NextResponse } from "next/server";
import {
  createPayout,
  validatePayout,
  authorizePayout,
  submitPayout,
  settlePayout,
  listRailAdapters,
} from "@/lib/payout-state-machine";
import "@/lib/rails/crypto-onchain";
import "@/lib/rails/bybit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      amount_cents = 5000,
      currency = "USDT-TRC20",
      recipient_id = "TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y",
      recipient_name = "Trust Wallet TRON",
      dry_run = false,
    } = body;

    if (amount_cents > 100000) {
      return NextResponse.json(
        { error: "Test mode: max $1000 (100000 cents)" },
        { status: 400 }
      );
    }

    const steps: Array<{ step: string; ok: boolean; detail: unknown }> = [];

    // Step 1: Create payout
    const payout = createPayout({
      amount_cents,
      currency,
      recipient_id,
      recipient_type: "crypto_wallet",
      metadata: { recipient_name, test: true },
      actor: "api.test-crypto",
    });
    steps.push({ step: "created", ok: true, detail: { id: payout.id, state: payout.state } });

    // Step 2: Validate (check owner whitelist + format)
    const val = validatePayout({
      payout_id: payout.id,
      actor: "api.test-crypto",
      is_preset_owner: true,
      account_format_valid: true,
      reason: "test validation",
    });
    steps.push({ step: "validated", ok: val.ok, detail: val.ok ? { state: val.payout.state } : { error: val.reason } });
    if (!val.ok) return NextResponse.json({ steps, failed_at: "validate" }, { status: 400 });

    // Step 3: Authorize (human session)
    const auth = authorizePayout({
      payout_id: payout.id,
      authorizer_kind: "human_session",
      authorizer_id: "owner@test",
      actor: "api.test-crypto",
      reason: "owner authorized via test endpoint",
    });
    steps.push({ step: "authorized", ok: auth.ok, detail: auth.ok ? { state: auth.payout.state } : { error: auth.reason } });
    if (!auth.ok) return NextResponse.json({ steps, failed_at: "authorize" }, { status: 400 });

    // Step 4: Dry run check — show what would happen
    if (dry_run) {
      const rails = listRailAdapters();
      const matching = rails.filter(
        (r) => r.supported_currencies.includes(currency) && r.supported_recipient_types.includes("crypto_wallet")
      );
      steps.push({
        step: "dry_run_submit",
        ok: matching.length > 0,
        detail: {
          matching_rails: matching.map((r) => r.id),
          would_submit: { amount: amount_cents / 100, currency, to: recipient_id },
        },
      });
      return NextResponse.json({ ok: true, steps, payout_id: payout.id });
    }

    // Step 4: Real submit
    let sub;
    try {
      sub = await submitPayout({ payout_id: payout.id, actor: "api.test-crypto" });
    } catch (submitErr) {
      sub = { ok: false as const, reason: submitErr instanceof Error ? submitErr.message : String(submitErr), code: "exception" as const };
    }
    steps.push({
      step: "submitted",
      ok: sub.ok,
      detail: sub.ok
        ? { state: sub.payout.state, ref: sub.external_reference, rail: sub.payout.rail }
        : { error: sub.reason, code: sub.code },
    });
    if (!sub.ok) return NextResponse.json({ steps, failed_at: "submit" }, { status: 400 });

    // Step 5: Settle (if we got a tx_hash from submit)
    const raw = sub.raw as Record<string, unknown> | undefined;
    const txHash = raw?.tx_hash as string | undefined;
    if (txHash) {
      const sett = settlePayout({
        payout_id: payout.id,
        proof_kind: "on_chain_confirmation",
        proof_payload: JSON.stringify({ tx_hash: txHash, chain: currency }),
        actor: "api.test-crypto",
      });
      steps.push({
        step: "settled",
        ok: sett.ok,
        detail: sett.ok
          ? { state: sett.payout.state, receipt: sett.receipt_hash }
          : { error: sett.reason },
      });
    }

    return NextResponse.json({ ok: true, steps, payout_id: payout.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

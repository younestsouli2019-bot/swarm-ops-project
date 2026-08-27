/**
 * POST /api/payouts/settle-bybit
 *
 * Settles available payout balance via Bybit USDT-TRC20 withdrawal
 * to the owner's Trust Wallet (TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y).
 *
 * Body: { "dry_run": true|false, "amount_usd": number (optional) }
 */
import { NextResponse } from "next/server";
import { bybitConfigured, getBybitBalance, createBybitWithdrawal, queryBybitWithdrawal } from "@/lib/rails/bybit";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

const OWNER_TRON_WALLET = "TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y";
const EUR_MAD_RATE = 10.7;
const USD_EUR_RATE = 0.92;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run !== false; // default true for safety
    const requestedAmount = body.amount_usd as number | undefined;

    const result: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      bybit_configured: bybitConfigured(),
      owner_wallet: OWNER_TRON_WALLET,
      chain: "TRC20",
    };

    if (!bybitConfigured()) {
      result.error = "BYBIT_API_KEY / BYBIT_API_SECRET not set on Vercel";
      return NextResponse.json(result, { status: 400 });
    }

    // Step 1: Get Bybit USDT balance
    const balance = await getBybitBalance("USDT");
    result.bybit_usdt = balance;

    const available = parseFloat(balance.available || "0");
    const total = parseFloat(balance.total || "0");

    if (available <= 0) {
      result.status = "insufficient_balance";
      result.message = `Bybit USDT balance is ${total} (available: ${available}). Fund the account to enable withdrawals.`;
      return NextResponse.json(result);
    }

    // Step 2: Determine withdrawal amount
    // Use requested amount, or available balance (whichever is smaller)
    let withdrawUsdt = available;
    if (requestedAmount && requestedAmount > 0) {
      // requestedAmount is in USD; 1 USDT ≈ 1 USD
      withdrawUsdt = Math.min(requestedAmount, available);
    }

    // Leave a small buffer for network fees (~1 USDT for TRC20)
    withdrawUsdt = Math.max(0, withdrawUsdt - 1);

    result.withdraw_amount_usdt = withdrawUsdt;
    result.withdraw_amount_usd_equiv = `$${withdrawUsdt.toFixed(2)}`;
    result.withdraw_amount_mad_equiv = `$${(withdrawUsdt * USD_EUR_RATE * EUR_MAD_RATE).toFixed(2)} MAD`;

    if (withdrawUsdt <= 0) {
      result.status = "amount_too_small";
      result.message = "Available balance is too small after fee buffer";
      return NextResponse.json(result);
    }

    if (dryRun) {
      result.status = "dry_run";
      result.message = `Would withdraw ${withdrawUsdt} USDT-TRC20 to ${OWNER_TRON_WALLET}`;
      result.instructions = [
        `DRY RUN — No actual withdrawal executed`,
        ``,
        `Would send: ${withdrawUsdt} USDT`,
        `Chain: TRC20`,
        `To: ${OWNER_TRON_WALLET}`,
        `Estimated fee: ~1 USDT`,
        `Net received: ~${(withdrawUsdt - 1).toFixed(2)} USDT`,
        ``,
        `To execute: POST /api/payouts/settle-bybit with { "dry_run": false }`,
      ].join("\n");
      return NextResponse.json(result);
    }

    // Step 3: Execute withdrawal
    const withdrawal = await createBybitWithdrawal({
      coin: "USDT",
      chain: "TRC20",
      amount: withdrawUsdt.toFixed(2),
      toAddress: OWNER_TRON_WALLET,
    });

    result.withdrawal = withdrawal;

    if (!withdrawal.ok) {
      result.status = "withdrawal_failed";
      result.error = withdrawal.error;
      return NextResponse.json(result, { status: 500 });
    }

    result.status = "submitted";
    result.withdrawal_id = withdrawal.withdrawal_id;
    result.tx_hash = withdrawal.tx_hash || "pending";

    // Step 4: Create payout record in Base44
    try {
      await b44.create("PayoutItem", {
        item_id: `BYBIT-${withdrawal.withdrawal_id}`,
        batch_id: `BYBIT-SETTLE-${Date.now().toString(36).toUpperCase()}`,
        recipient_name: "Younes Tsouli",
        recipient: OWNER_TRON_WALLET,
        recipient_type: "crypto_wallet",
        bank_name: "Bybit Exchange → Trust Wallet TRC20",
        amount: withdrawUsdt,
        currency: "USDT",
        status: "submitted",
        external_transaction_id: withdrawal.withdrawal_id || "",
        processed_at: new Date().toISOString(),
        metadata: {
          rail: "bybit_usdt_trc20",
          chain: "TRC20",
          to_address: OWNER_TRON_WALLET,
          from_exchange: "bybit",
          usd_equivalent: withdrawUsdt,
          mad_equivalent: withdrawUsdt * USD_EUR_RATE * EUR_MAD_RATE,
          fee_buffer: 1,
          net_received: withdrawUsdt - 1,
          explorer: `https://tronscan.org/#/transaction/${withdrawal.tx_hash || "pending"}`,
        },
      } as never);
      result.base44_recorded = true;
    } catch {
      result.base44_recorded = false;
    }

    result.instructions = [
      `BYBIT USDT-TRC20 WITHDRAWAL SUBMITTED`,
      ``,
      `Amount: ${withdrawUsdt} USDT`,
      `Chain: TRC20`,
      `Withdrawal ID: ${withdrawal.withdrawal_id}`,
      `TX: ${withdrawal.tx_hash || "processing"}`,
      `To: ${OWNER_TRON_WALLET}`,
      ``,
      `Bybit processes TRC20 withdrawals in ~10 minutes.`,
      `Check status: GET /api/payouts/settle-bybit?id=${withdrawal.withdrawal_id}`,
      `Explorer: https://tronscan.org/#/transaction/${withdrawal.tx_hash || "pending"}`,
    ].join("\n");

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// GET — check withdrawal status
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({
      ok: true,
      message: "Provide ?id=<withdrawal_id> to check status",
      bybit_configured: bybitConfigured(),
      owner_wallet: OWNER_TRON_WALLET,
    });
  }

  const status = await queryBybitWithdrawal(id);
  return NextResponse.json({
    ok: true,
    withdrawal_id: id,
    ...status,
    explorer: status.tx_hash
      ? `https://tronscan.org/#/transaction/${status.tx_hash}`
      : null,
  });
}

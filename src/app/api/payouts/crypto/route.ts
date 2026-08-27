import { NextResponse } from "next/server";
import {
  submitPayout,
  settlePayout,
  listRailAdapters,
  type PayoutItem,
} from "@/lib/payout-state-machine";
import "@/lib/rails/crypto-onchain";
import "@/lib/rails/bybit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/payouts/crypto
 *
 * Execute a crypto payout to an owner wallet.
 * Body: {
 *   action: "submit" | "settle" | "status",
 *   payout_id?: string,    // for submit/settle
 *   proof_payload?: string, // for settle (on-chain tx hash or webhook body)
 *   amount_cents?: number,  // for submit (if creating new)
 *   currency?: string,      // "BTC" | "ETH" | "USDT" | "USDT-TRC20" | "USDT-ERC20"
 *   recipient_id?: string,  // crypto wallet address
 * }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "status") {
      const rails = listRailAdapters();
      const cryptoRail = rails.find((r) => r.rail === "crypto_onchain");
      return NextResponse.json({
        ok: true,
        crypto_adapter: cryptoRail ? "registered" : "not_found",
        supported_currencies: cryptoRail?.supported_currencies ?? [],
        rails: rails.map((r) => ({ id: r.id, rail: r.rail, currencies: r.supported_currencies })),
      });
    }

    if (action === "submit") {
      const { payout_id } = body;
      if (!payout_id) {
        return NextResponse.json({ error: "payout_id required for submit" }, { status: 400 });
      }

      const result = await submitPayout({
        payout_id,
        actor: "api.payouts.crypto",
      });

      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.reason, code: result.code }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        payout_id: result.payout.id,
        external_reference: result.external_reference,
        state: result.payout.state,
        rail: result.payout.rail,
        explorer_url: (result.payout as PayoutItem & { raw?: { explorer_url?: string } }).raw?.explorer_url,
      });
    }

    if (action === "settle") {
      const { payout_id, proof_payload } = body;
      if (!payout_id || !proof_payload) {
        return NextResponse.json({ error: "payout_id and proof_payload required for settle" }, { status: 400 });
      }

      const result = settlePayout({
        payout_id,
        actor: "api.payouts.crypto",
        proof_kind: "on_chain_confirmation",
        proof_payload,
      });

      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.reason }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        payout_id: result.payout.id,
        receipt_hash: result.receipt_hash,
        state: result.payout.state,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

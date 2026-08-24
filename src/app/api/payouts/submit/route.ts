/**
 * POST /api/payouts/submit
 *
 * Transition a payout from `authorized` → `submitted`.
 *
 * Calls the registered rail adapter's submit() method. If no adapter is
 * registered for the payout's recipient_type + currency, returns
 * { ok: false, code: "no_live_rail" } — the payout stays in `authorized`.
 *
 * This endpoint WILL NOT register stub rail adapters. The whole point of
 * the state machine is that no payout leaves this system until a real
 * licensed PSP is integrated.
 */

import { NextResponse } from "next/server";
import { submitPayout, listRailAdapters } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { payout_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.payout_id) {
    return NextResponse.json({ error: "payout_id is required" }, { status: 400 });
  }
  const result = await submitPayout({ payout_id: body.payout_id, actor: "api:/api/payouts/submit" });
  if (!result.ok) {
    // no_live_rail is the expected state for this sandbox — return 409
    // with a clear explanation, NOT a 500.
    if (result.code === "no_live_rail") {
      return NextResponse.json(
        {
          error: result.reason,
          code: "no_live_rail",
          explanation:
            "No licensed payment service provider (PSP) is registered as a rail adapter. " +
            "To submit payouts to a real rail, integrate a licensed PSP (Stripe, Wise, " +
            "Currencycloud, etc.) by calling registerRailAdapter() with a real adapter " +
            "implementation. Until then, payouts remain in `authorized` state.",
          registered_rails: listRailAdapters(),
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: result.reason, code: result.code }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    payout: result.payout,
    external_reference: result.external_reference,
  });
}

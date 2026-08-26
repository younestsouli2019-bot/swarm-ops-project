/**
 * POST /api/webhooks/nowpayments
 *
 * NOWPayments IPN handler — confirms crypto payments and creates RevenueEvents.
 */

import { NextResponse } from "next/server";
import { handleCryptoIPN, CRYPTO_CONFIGURED } from "@/lib/payment-collection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!CRYPTO_CONFIGURED) {
    return NextResponse.json({ error: "Crypto payments not configured" }, { status: 503 });
  }

  const signature = request.headers.get("x-nowpayments-sig") || "";
  const body = await request.text();

  const result = await handleCryptoIPN(body, signature);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ received: true });
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "NOWPayments IPN webhook endpoint.",
    configured: CRYPTO_CONFIGURED,
  });
}

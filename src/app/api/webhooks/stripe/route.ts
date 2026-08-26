/**
 * POST /api/webhooks/stripe
 *
 * Stripe webhook handler — confirms payments and creates RevenueEvents.
 * Revenue is auto-settled to owner's Wise/Attijariwafa accounts.
 */

import { NextResponse } from "next/server";
import { handleStripeWebhook, STRIPE_CONFIGURED } from "@/lib/payment-collection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!STRIPE_CONFIGURED) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature") || "";
  const body = await request.text();

  const result = await handleStripeWebhook(body, signature);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ received: true, type: result.event_type });
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "Stripe webhook endpoint. Send POST requests with stripe-signature header.",
    configured: STRIPE_CONFIGURED,
  });
}

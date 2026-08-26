/**
 * POST /api/webhooks/paypal
 *
 * PayPal webhook handler — captures orders and creates RevenueEvents.
 */

import { NextResponse } from "next/server";
import { capturePayPalOrder, PAYPAL_CONFIGURED } from "@/lib/payment-collection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!PAYPAL_CONFIGURED) {
    return NextResponse.json({ error: "PayPal not configured" }, { status: 503 });
  }

  let body: { resource?: { id?: string }; event_type?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.event_type === "CHECKOUT.ORDER.APPROVED" && body.resource?.id) {
    const result = await capturePayPalOrder(body.resource.id);
    return NextResponse.json({ received: true, captured: result.ok, payer_id: result.payer_id });
  }

  return NextResponse.json({ received: true, event_type: body.event_type });
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "PayPal webhook endpoint.",
    configured: PAYPAL_CONFIGURED,
  });
}

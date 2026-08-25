/**
 * Payment Status API
 *
 * GET /api/payments/status?order_id=xxx — check payment status
 * POST /api/payments/create — create a payment intent
 */

import { NextResponse } from "next/server";
import { MoroccanPSP } from "@/lib/payments/moroccan-psp";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── GET: Check Status ──────────────────────────────────────────────

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order_id");

  if (!orderId) {
    return NextResponse.json(
      { ok: false, error: "order_id required" },
      { status: 400 }
    );
  }

  // Check in Base44
  try {
    const callbacks = await b44.list("PaymentCallback", {
      filter: `order_id="${orderId}"`,
      limit: 1,
    });

    if (callbacks && callbacks.length > 0) {
      const cb = callbacks[0];
      return NextResponse.json({
        ok: true,
        order_id: orderId,
        status: cb.status,
        amount: cb.amount,
        currency: cb.currency,
        provider: cb.provider,
        received_at: cb.received_at,
      });
    }
  } catch {
    // Non-fatal
  }

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    status: "not_found",
    message: "No payment callback received yet",
  });
}

// ─── POST: Create Payment ───────────────────────────────────────────

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  if (!body.amount || !body.order_id) {
    return NextResponse.json(
      { ok: false, error: "amount and order_id required" },
      { status: 400 }
    );
  }

  const psp = new MoroccanPSP();

  if (!psp.isAvailable()) {
    return NextResponse.json(
      {
        ok: false,
        error: "No Moroccan PSP configured",
        config_needed: [
          "MOROCCAN_PSP=cmi|payzone|charipay",
          "CMI_MERCHANT_ID, CMI_CLIENT_ID, CMI_STORE_KEY (for CMI)",
          "PAYZONE_API_KEY, PAYZONE_MERCHANT_ID (for Payzone)",
          "CHARIPAY_API_KEY, CHARIPAY_MERCHANT_ID (for Chari Pay)",
        ],
      },
      { status: 503 }
    );
  }

  const result = await psp.createPayment({
    id: `PAY-${Date.now().toString(36).toUpperCase()}`,
    amount: body.amount,
    currency: body.currency || "MAD",
    customer_email: body.customer_email,
    customer_name: body.customer_name,
    description: body.description || "HIT Swarm Payment",
    order_id: body.order_id,
  });

  return NextResponse.json({
    ok: result.success,
    ...result,
    timestamp: new Date().toISOString(),
  });
}

/**
 * POST /api/checkout/create
 *
 * Creates a checkout session for any payment method.
 * Returns URLs for Stripe, PayPal, or crypto payment.
 *
 * Body: { product_id, method: "stripe"|"paypal"|"crypto", currency?, email? }
 */

import { NextResponse } from "next/server";
import {
  createStripeCheckoutSession,
  createPayPalOrder,
  createCryptoPayment,
  PRODUCTS,
  STRIPE_CONFIGURED,
  PAYPAL_CONFIGURED,
  CRYPTO_CONFIGURED,
} from "@/lib/payment-collection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { product_id?: string; method?: string; currency?: string; email?: string };
  try { body = await request.json(); } catch { body = {}; }

  const { product_id, method = "stripe", currency, email } = body;
  if (!product_id) {
    return NextResponse.json({ error: "product_id required" }, { status: 400 });
  }

  const product = PRODUCTS.find((p) => p.id === product_id);
  if (!product) {
    return NextResponse.json({ error: `Unknown product: ${product_id}` }, { status: 400 });
  }

  const baseUrl = "https://swarm-ops-project.vercel.app";

  switch (method) {
    case "stripe": {
      if (!STRIPE_CONFIGURED) {
        return NextResponse.json({
          error: "Stripe not configured",
          setup: "Set STRIPE_SECRET_KEY on Vercel → https://dashboard.stripe.com/apikeys",
          fallback: "Use method=paypal or method=crypto instead",
        }, { status: 503 });
      }
      const result = await createStripeCheckoutSession({
        product_id,
        customer_email: email,
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/checkout?cancelled=true`,
        currency,
      });
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ ok: true, url: result.url, session_id: result.session_id, method: "stripe" });
    }

    case "paypal": {
      if (!PAYPAL_CONFIGURED) {
        return NextResponse.json({
          error: "PayPal not configured",
          setup: "Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET on Vercel",
          fallback: "Use method=stripe or method=crypto instead",
        }, { status: 503 });
      }
      const result = await createPayPalOrder({ product_id, currency: currency?.toUpperCase() });
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ ok: true, url: result.url, order_id: result.order_id, method: "paypal" });
    }

    case "crypto": {
      if (!CRYPTO_CONFIGURED) {
        return NextResponse.json({
          error: "Crypto payments not configured",
          setup: "Set NOWPAYMENTS_API_KEY on Vercel → https://nowpayments.io",
          fallback: "Use method=stripe or method=paypal instead",
        }, { status: 503 });
      }
      const result = await createCryptoPayment({ product_id, currency });
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ ok: true, ...result, method: "crypto" });
    }

    default:
      return NextResponse.json({ error: `Unknown method: ${method}. Use stripe, paypal, or crypto.` }, { status: 400 });
  }
}

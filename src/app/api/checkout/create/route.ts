/**
 * POST /api/checkout/create
 *
 * Creates a checkout session for any payment method.
 * Returns URLs for Stripe, PayPal, or crypto payment, and a
 * hosted CMI (Attijari SimplePay) form for card payments.
 *
 * Body: { product_id, method: "stripe"|"paypal"|"crypto"|"cmi", currency?, email? }
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
import { MoroccanPSP } from "@/lib/payments/moroccan-psp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set([
  "https://realworldcerts.com",
  "https://www.realworldcerts.com",
  ...(process.env.CHECKOUT_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : (ALLOWED_ORIGINS.has("https://realworldcerts.com") ? "https://realworldcerts.com" : "*"),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  let body: { product_id?: string; method?: string; currency?: string; email?: string };
  try { body = await request.json(); } catch { body = {}; }

  const headers = corsHeaders(request);
  const send = (json: unknown, status: number) => NextResponse.json(json, { status, headers });

  const { product_id, method = "stripe", currency, email } = body;
  if (!product_id) {
    return send({ error: "product_id required" }, 400);
  }

  const product = PRODUCTS.find((p) => p.id === product_id);
  if (!product) {
    return send({ error: `Unknown product: ${product_id}` }, 400);
  }

  const baseUrl = process.env.CHECKOUT_BASE_URL || "https://swarm-ops-project.vercel.app";

  switch (method) {
    case "stripe": {
      if (!STRIPE_CONFIGURED) {
        return send({
          error: "Stripe not configured",
          setup: "Set STRIPE_SECRET_KEY on Vercel → https://dashboard.stripe.com/apikeys",
          fallback: "Use method=paypal or method=crypto instead",
        }, 503);
      }
      const result = await createStripeCheckoutSession({
        product_id,
        customer_email: email,
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/checkout?cancelled=true`,
        currency,
      });
      if ("error" in result) {
        return send({ error: result.error }, 500);
      }
      return send({ ok: true, url: result.url, session_id: result.session_id, method: "stripe" }, 200);
    }

    case "paypal": {
      if (!PAYPAL_CONFIGURED) {
        return send({
          error: "PayPal not configured",
          setup: "Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET on Vercel",
          fallback: "Use method=stripe or method=crypto instead",
        }, 503);
      }
      const result = await createPayPalOrder({ product_id, currency: currency?.toUpperCase() });
      if ("error" in result) {
        return send({ error: result.error }, 500);
      }
      return send({ ok: true, url: result.url, order_id: result.order_id, method: "paypal" }, 200);
    }

    case "crypto": {
      if (!CRYPTO_CONFIGURED) {
        return send({
          error: "Crypto payments not configured",
          setup: "Set NOWPAYMENTS_API_KEY on Vercel → https://nowpayments.io",
          fallback: "Use method=stripe or method=paypal instead",
        }, 503);
      }
      const result = await createCryptoPayment({ product_id, currency });
      if ("error" in result) {
        return send({ error: result.error }, 500);
      }
      return send({ ok: true, ...result, method: "crypto" }, 200);
    }

    case "cmi": {
      const psp = new MoroccanPSP();
      if (!psp.isAvailable()) {
        return send({
          error: "CMI (Attijari SimplePay) not configured",
          setup: "Set CMI_MERCHANT_ID, CMI_CLIENT_ID, CMI_STORE_KEY on Vercel (and CMI_OK_URL, CMI_FAIL_URL, CMI_CALLBACK_URL).",
          fallback: "Use method=paypal or method=crypto instead",
        }, 503);
      }
      if (!email) {
        return send({ error: "email required for CMI card checkout" }, 400);
      }
      const orderId = `RWC-${product.id}-${Date.now().toString(36).toUpperCase()}`;
      const result = await psp.createPayment({
        id: orderId,
        amount: product.price_usd,
        currency: "MAD",
        customer_email: email,
        description: `${product.name} — ${product_id}`,
        order_id: orderId,
        metadata: { product_id, category: product.category, source: "realworldcerts-checkout" },
      });
      if (!result.success || !result.redirect_url) {
        return send({ error: result.error || "CMI payment could not be created" }, 500);
      }
      return send({
        ok: true,
        method: "cmi",
        form_action: result.redirect_url,
        fields: result.form_fields ?? {},
        order_id: orderId,
      }, 200);
    }

    default:
      return send({ error: `Unknown method: ${method}. Use stripe, paypal, crypto, or cmi.` }, 400);
  }
}

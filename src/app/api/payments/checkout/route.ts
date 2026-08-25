/**
 * Checkout Page
 *
 * Renders a payment form that submits to CMI.
 * Or redirects to the PSP checkout URL.
 */

import { NextResponse } from "next/server";
import { detectMoroccanPSP } from "@/lib/payments/moroccan-psp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order_id");
  const amount = url.searchParams.get("amount");

  if (!orderId || !amount) {
    return new Response("Missing order_id or amount", { status: 400 });
  }

  const psp = detectMoroccanPSP();

  if (psp.provider === "cmi" && psp.enabled) {
    // Generate CMI form
    const { CMIClient } = await import("@/lib/payments/cmi");
    const client = new CMIClient({
      merchant_id: process.env.CMI_MERCHANT_ID || "",
      client_id: process.env.CMI_CLIENT_ID || "",
      store_key: process.env.CMI_STORE_KEY || "",
      ok_url: process.env.CMI_OK_URL || `${url.origin}/payment/success`,
      fail_url: process.env.CMI_FAIL_URL || `${url.origin}/payment/failed`,
      shop_url: process.env.CMI_SHOP_URL || url.origin,
      callback_url: process.env.CMI_CALLBACK_URL || `${url.origin}/api/payments/cmi/callback`,
    });

    const payment = client.generatePaymentRequest({
      amount: parseFloat(amount),
      order_id: orderId,
      auto_redirect: true,
    });

    // Return auto-submitting HTML form
    const inputs = Object.entries(payment.payload)
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
      .join("\n");

    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>Redirecting to CMI...</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid #f3f3f3; border-top: 3px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin: 1rem auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h2>Redirecting to CMI Payment...</h2>
    <div class="spinner"></div>
    <p>Amount: ${amount} MAD</p>
    <p>Order: ${orderId}</p>
    <form id="cmi-form" method="POST" action="${payment.gateway_url}">
      ${inputs}
    </form>
    <script>document.getElementById('cmi-form').submit();</script>
  </div>
</body>
</html>`,
      {
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  // Other PSPs: return checkout URL
  return NextResponse.json({
    ok: false,
    error: `Checkout for ${psp.provider} not yet implemented`,
    config: psp,
  });
}

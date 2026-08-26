/**
 * GET /api/products
 *
 * Lists all available products for the storefront.
 */

import { NextResponse } from "next/server";
import { PRODUCTS, STRIPE_CONFIGURED, PAYPAL_CONFIGURED, CRYPTO_CONFIGURED } from "@/lib/payment-collection";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    products: PRODUCTS,
    payment_methods: {
      stripe: STRIPE_CONFIGURED,
      paypal: PAYPAL_CONFIGURED,
      crypto: CRYPTO_CONFIGURED,
    },
    owner_accounts: {
      wise_gbp: "GB70TRWI60846495805703",
      attijari_mad: "007810000448200061321372",
      banking_circle_eur: "LU774080000041265646",
    },
    checkout_url: "https://swarm-ops-project.vercel.app/checkout",
  });
}

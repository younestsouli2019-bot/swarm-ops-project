/**
 * Payment Collection Engine — collects real money from customers
 * and routes it directly to pre-set owner accounts.
 *
 * Supports:
 *   - Stripe Checkout (cards, Apple Pay, Google Pay)
 *   - PayPal Checkout
 *   - Crypto wallets (BTC/ETH/USDT via NOWPayments or manual)
 *
 * Flow:
 *   1. Customer visits checkout page
 *   2. Selects product → creates checkout session
 *   3. Payment confirmed via webhook
 *   4. RevenueEvent created in Base44
 *   5. Auto-settle routes funds to owner's Wise/Attijariwafa account
 *
 * Env vars:
 *   STRIPE_SECRET_KEY        — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET    — Stripe webhook signing secret
 *   STRIPE_PRICE_ID          — Default price for courses
 *   PAYPAL_CLIENT_ID         — PayPal client ID
 *   PAYPAL_CLIENT_SECRET     — PayPal client secret
 *   NOWPAYMENTS_API_KEY      — NOWPayments API key (crypto)
 *   NOWPAYMENTS_IPN_SECRET   — NOWPayments IPN secret
 */

import Stripe from "stripe";
import { b44 } from "./base44";

// ─── Stripe Setup ───────────────────────────────────────────────────

const stripeKey = process.env.STRIPE_SECRET_KEY;
export const STRIPE_CONFIGURED = !!stripeKey;

let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance && stripeKey) {
    stripeInstance = new Stripe(stripeKey, {
      apiVersion: "2024-12-18.acacia" as never,
    });
  }
  return stripeInstance!;
}

// ─── Owner Destination Accounts ─────────────────────────────────────

export const OWNER_DESTINATIONS = {
  wise_gbp: {
    iban: process.env.WISE_SOURCE_ACCOUNT || "GB70TRWI60846495805703",
    name: "Younes Tsouli",
    bic: "TRWIGB2LXXX",
    currency: "GBP",
    description: "Wise UK — GBP domestic credit",
  },
  attijari_1: {
    iban: process.env.ATTIJARI_ACCOUNT_1 || "007810000448200061321372",
    name: "YOUNES TSOULI",
    bic: "BMCEMAMX",
    currency: "MAD",
    description: "Attijariwafa Bank Morocco — MAD",
  },
  attijari_2: {
    iban: process.env.ATTIJARI_ACCOUNT_2 || "007810000448500030594182",
    name: "YOUNES TSOULI",
    bic: "BMCEMAMX",
    currency: "MAD",
    description: "Attijariwafa Bank Morocco — backup",
  },
  banking_circle: {
    iban: "LU774080000041265646",
    name: "YOUNES TSOULI",
    bic: "BCIRLULL",
    currency: "EUR",
    description: "Banking Circle Luxembourg — EUR",
  },
};

// ─── Product Catalog ────────────────────────────────────────────────

export interface Product {
  id: string;
  name: string;
  description: string;
  price_usd: number;
  price_gbp: number;
  price_eur: number;
  category: "course" | "certification" | "subscription" | "service";
  delivery: "instant" | "24h" | "manual";
  url?: string;
}

export const PRODUCTS: Product[] = [
  // Certification Exam Prep Courses
  {
    id: "course-aws-iot",
    name: "AWS Certified IoT Specialty Exam",
    description: "Complete prep for AWS IoT Specialty certification. 200+ practice questions.",
    price_usd: 20,
    price_gbp: 16,
    price_eur: 18,
    category: "course",
    delivery: "instant",
    url: "https://www.udemy.com/course/aws-iot-specialty/",
  },
  {
    id: "course-aws-devops",
    name: "AWS DevOps Engineer Professional Exam",
    description: "Master AWS DevOps. Full practice exam with explanations.",
    price_usd: 20,
    price_gbp: 16,
    price_eur: 18,
    category: "course",
    delivery: "instant",
    url: "https://www.udemy.com/course/aws-devops-professional/",
  },
  {
    id: "course-cissp",
    name: "CISSP Certification Practice Exam",
    description: "CISSP exam prep with 300+ questions and detailed answers.",
    price_usd: 20,
    price_gbp: 16,
    price_eur: 18,
    category: "certification",
    delivery: "instant",
  },
  {
    id: "course-cka",
    name: "Certified Kubernetes Administrator (CKA)",
    description: "CKA exam prep with hands-on labs and practice tests.",
    price_usd: 15,
    price_gbp: 12,
    price_eur: 14,
    category: "certification",
    delivery: "instant",
  },
  {
    id: "course-pmp",
    name: "Project Management Professional (PMP) Exam",
    description: "PMP certification prep with 500+ practice questions.",
    price_usd: 15,
    price_gbp: 12,
    price_eur: 14,
    category: "certification",
    delivery: "instant",
  },
  {
    id: "course-ceh",
    name: "CEH v13 Certification Exam Prep",
    description: "Certified Ethical Hacker v13 practice exams.",
    price_usd: 20,
    price_gbp: 16,
    price_eur: 18,
    category: "certification",
    delivery: "instant",
  },
  {
    id: "course-ccsp",
    name: "Certified Cloud Security Professional (CCSP)",
    description: "CCSP exam prep with cloud security focus.",
    price_usd: 15,
    price_gbp: 12,
    price_eur: 14,
    category: "certification",
    delivery: "instant",
  },
  {
    id: "course-docker",
    name: "Docker Certified Associate (DCA) Exam",
    description: "DCA exam prep with container orchestration focus.",
    price_usd: 20,
    price_gbp: 16,
    price_eur: 18,
    category: "certification",
    delivery: "instant",
  },
  // Subscription
  {
    id: "sub-swarm-pro",
    name: "HIT Swarm Pro — Monthly",
    description: "Access to 500 AI agents, premium course library, priority support.",
    price_usd: 49,
    price_gbp: 39,
    price_eur: 45,
    category: "subscription",
    delivery: "instant",
  },
  // Services
  {
    id: "svc-cert-bundle",
    name: "Certification Bundle — 5 Exams",
    description: "Pick any 5 certification practice exams at 40% discount.",
    price_usd: 60,
    price_gbp: 48,
    price_eur: 55,
    category: "service",
    delivery: "instant",
  },
];

// ─── Stripe Checkout ────────────────────────────────────────────────

export async function createStripeCheckoutSession(opts: {
  product_id: string;
  customer_email?: string;
  success_url: string;
  cancel_url: string;
  currency?: string;
}): Promise<{ url: string; session_id: string } | { error: string }> {
  if (!STRIPE_CONFIGURED) {
    return { error: "Stripe not configured. Set STRIPE_SECRET_KEY on Vercel." };
  }

  const product = PRODUCTS.find((p) => p.id === opts.product_id);
  if (!product) return { error: `Unknown product: ${opts.product_id}` };

  const stripe = getStripe();
  const currency = opts.currency || "usd";
  const amount =
    currency === "gbp" ? product.price_gbp :
    currency === "eur" ? product.price_eur :
    product.price_usd;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: product.name,
              description: product.description,
              metadata: {
                product_id: product.id,
                category: product.category,
                swarm: "hit-swarm",
              },
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        product_id: product.id,
        category: product.category,
        source: "hit-swarm-checkout",
      },
      customer_email: opts.customer_email,
      success_url: opts.success_url,
      cancel_url: opts.cancel_url,
    });

    return { url: session.url!, session_id: session.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Stripe Webhook Handler ─────────────────────────────────────────

export async function handleStripeWebhook(
  body: string,
  signature: string
): Promise<{ ok: boolean; event_type?: string; error?: string }> {
  if (!STRIPE_CONFIGURED) {
    return { ok: false, error: "Stripe not configured" };
  }

  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } else {
      event = JSON.parse(body) as Stripe.Event;
    }
  } catch (err) {
    return { ok: false, error: `Webhook signature invalid: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const productId = session.metadata?.product_id || "unknown";
    const amount = (session.amount_total || 0) / 100;
    const currency = (session.currency || "usd").toUpperCase();

    // Create RevenueEvent in Base44
    await b44.create("RevenueEvent", {
      event_id: `REV-${Date.now().toString(36).toUpperCase()}`,
      source: "product_sale",
      amount,
      currency,
      status: "confirmed",
      confirmation_date: new Date().toISOString(),
      event_hash: `stripe_${session.payment_intent || session.id}`,
      description: `Stripe checkout: ${productId} — $${amount} ${currency}`,
      metadata: {
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent,
        product_id: productId,
        customer_email: session.customer_email,
        collection_rail: "stripe",
        destination: "wise_gbp",
      },
    });

    return { ok: true, event_type: event.type };
  }

  return { ok: true, event_type: event.type };
}

// ─── PayPal Checkout ────────────────────────────────────────────────

const PP_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PP_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
export const PAYPAL_CONFIGURED = !!(PP_CLIENT_ID && PP_CLIENT_SECRET);

async function getPayPalToken(): Promise<string> {
  const res = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function createPayPalOrder(opts: {
  product_id: string;
  currency?: string;
}): Promise<{ url: string; order_id: string } | { error: string }> {
  if (!PAYPAL_CONFIGURED) {
    return { error: "PayPal not configured. Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET on Vercel." };
  }

  const product = PRODUCTS.find((p) => p.id === opts.product_id);
  if (!product) return { error: `Unknown product: ${opts.product_id}` };

  const currency = (opts.currency || "USD").toUpperCase();
  const amount =
    currency === "GBP" ? product.price_gbp :
    currency === "EUR" ? product.price_eur :
    product.price_usd;

  try {
    const token = await getPayPalToken();
    const res = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: currency, value: amount.toFixed(2) },
            description: product.name,
            custom_id: product.id,
          },
        ],
        application_context: {
          brand_name: "HIT Swarm",
          landing_page: "BILLING",
          user_action: "PAY_NOW",
        },
      }),
    });

    const data = (await res.json()) as { id: string; links: Array<{ rel: string; href: string }> };
    const approveLink = data.links.find((l) => l.rel === "approve");
    return { url: approveLink?.href || "", order_id: data.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function capturePayPalOrder(
  orderId: string
): Promise<{ ok: boolean; payer_id?: string; amount?: string; error?: string }> {
  try {
    const token = await getPayPalToken();
    const res = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await res.json()) as {
      id: string;
      payer: { payer_id: string };
      purchase_units: Array<{ payments: { captures: Array<{ amount: { value: string; currency_code: string } }> } }>;
    };

    const capture = data.purchase_units[0]?.payments?.captures[0];
    const amount = capture?.amount?.value;
    const currency = capture?.amount?.currency_code;

    if (amount && currency) {
      await b44.create("RevenueEvent", {
        event_id: `REV-${Date.now().toString(36).toUpperCase()}`,
        source: "product_sale",
        amount: parseFloat(amount),
        currency,
        status: "confirmed",
        confirmation_date: new Date().toISOString(),
        event_hash: `paypal_${orderId}`,
        description: `PayPal checkout: ${orderId} — ${currency} ${amount}`,
        metadata: {
          paypal_order_id: orderId,
          paypal_payer_id: data.payer?.payer_id,
          collection_rail: "paypal",
          destination: "wise_gbp",
        },
      });
    }

    return { ok: true, payer_id: data.payer?.payer_id, amount };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Crypto Payments (NOWPayments) ──────────────────────────────────

const NOW_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOW_IPN = process.env.NOWPAYMENTS_IPN_SECRET;
export const CRYPTO_CONFIGURED = !!NOW_KEY;

export async function createCryptoPayment(opts: {
  product_id: string;
  currency?: string;
}): Promise<{ payment_id: string; pay_address: string; amount: string; currency: string } | { error: string }> {
  if (!NOW_KEY) {
    return { error: "NOWPayments not configured. Set NOWPAYMENTS_API_KEY on Vercel." };
  }

  const product = PRODUCTS.find((p) => p.id === opts.product_id);
  if (!product) return { error: `Unknown product: ${opts.product_id}` };

  const currency = (opts.currency || "btc").toLowerCase();

  try {
    const res = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": NOW_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount: product.price_usd,
        price_currency: "usd",
        pay_currency: currency,
        order_id: `SWARM-${Date.now()}`,
        order_description: product.name,
      }),
    });

    const data = (await res.json()) as { id: number; pay_address: string; pay_amount: string; pay_currency: string };
    return {
      payment_id: String(data.id),
      pay_address: data.pay_address,
      amount: data.pay_amount,
      currency: data.pay_currency.toUpperCase(),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleCryptoIPN(
  body: string,
  signature: string
): Promise<{ ok: boolean; error?: string }> {
  if (!NOW_IPN) return { ok: false, error: "NOWPayments IPN not configured" };

  try {
    const data = JSON.parse(body) as {
      order_id: string;
      pay_amount: number;
      pay_currency: string;
      actually_paid: number;
      order_status: string;
    };

    if (data.order_status === "finished" && data.actually_paid > 0) {
      await b44.create("RevenueEvent", {
        event_id: `REV-${Date.now().toString(36).toUpperCase()}`,
        source: "product_sale",
        amount: data.actually_paid,
        currency: data.pay_currency.toUpperCase(),
        status: "confirmed",
        confirmation_date: new Date().toISOString(),
        event_hash: `crypto_${data.order_id}`,
        description: `Crypto payment: ${data.order_id} — ${data.pay_currency.toUpperCase()} ${data.actually_paid}`,
        metadata: {
          nowpayments_order_id: data.order_id,
          pay_currency: data.pay_currency,
          collection_rail: "crypto",
          destination: "wise_gbp",
        },
      });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Simple Invoice Creator (no SDK needed) ─────────────────────────

export function createInvoiceUrl(opts: {
  product_id: string;
  base_url: string;
}): string {
  const product = PRODUCTS.find((p) => p.id === opts.product_id);
  if (!product) return `${opts.base_url}/checkout?error=unknown_product`;

  return `${opts.base_url}/checkout?product=${product.id}`;
}

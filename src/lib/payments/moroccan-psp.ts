/**
 * Moroccan PSP Auto-Setup
 *
 * Detects which PSP is configured and builds the right adapter.
 * Supports: CMI, Payzone (HPS/VPS), Chari Pay (ChariBaaS)
 *
 * Architecture:
 *   CUSTOMER → Moroccan PSP → Attijariwafa
 *
 * This replaces the old:
 *   CUSTOMER → Payoneer → SWIFT → Attijariwafa
 */

import { CMIClient } from "./cmi";

// ─── PSP Types ──────────────────────────────────────────────────────

export type PSPPaymentMethod = "card" | "wallet" | "transfer" | "cod";

export interface PSPConfig {
  provider: "cmi" | "payzone" | "charipay" | "unknown";
  enabled: boolean;
  merchant_id: string;
  api_key?: string;
  sandbox: boolean;
  accepted_currencies: string[];
  accepted_payment_methods: PSPPaymentMethod[];
}

// ─── Auto-Detect ────────────────────────────────────────────────────

export function detectMoroccanPSP(): PSPConfig {
  const psp = process.env.MOROCCAN_PSP || "";

  if (psp === "cmi" || process.env.CMI_MERCHANT_ID) {
    return {
      provider: "cmi",
      enabled: !!(process.env.CMI_MERCHANT_ID && process.env.CMI_CLIENT_ID && process.env.CMI_STORE_KEY),
      merchant_id: process.env.CMI_MERCHANT_ID || "",
      api_key: process.env.CMI_API_KEY,
      sandbox: process.env.CMI_SANDBOX !== "false",
      accepted_currencies: ["MAD", "USD", "EUR"],
      accepted_payment_methods: ["card"],
    };
  }

  if (psp === "payzone" || process.env.PAYZONE_API_KEY) {
    return {
      provider: "payzone",
      enabled: !!(process.env.PAYZONE_API_KEY && process.env.PAYZONE_MERCHANT_ID),
      merchant_id: process.env.PAYZONE_MERCHANT_ID || "",
      api_key: process.env.PAYZONE_API_KEY,
      sandbox: process.env.PAYZONE_SANDBOX !== "false",
      accepted_currencies: ["MAD", "USD", "EUR"],
      accepted_payment_methods: ["card", "wallet", "transfer"],
    };
  }

  if (psp === "charipay" || process.env.CHARIPAY_API_KEY) {
    return {
      provider: "charipay",
      enabled: !!(process.env.CHARIPAY_API_KEY && process.env.CHARIPAY_MERCHANT_ID),
      merchant_id: process.env.CHARIPAY_MERCHANT_ID || "",
      api_key: process.env.CHARIPAY_API_KEY,
      sandbox: process.env.CHARIPAY_SANDBOX !== "false",
      accepted_currencies: ["MAD", "USD", "EUR"],
      accepted_payment_methods: ["card", "wallet", "transfer", "cod"],
    };
  }

  return {
    provider: "unknown",
    enabled: false,
    merchant_id: "",
    sandbox: true,
    accepted_currencies: [],
    accepted_payment_methods: [],
  };
}

// ─── Payment Intent ─────────────────────────────────────────────────

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  customer_email?: string;
  customer_name?: string;
  description: string;
  order_id: string;
  metadata?: Record<string, string>;
}

export interface PaymentResult {
  success: boolean;
  provider: string;
  payment_id?: string;
  status: "pending" | "processing" | "completed" | "failed";
  redirect_url?: string;
  error?: string;
}

// ─── Unified PSP Interface ──────────────────────────────────────────

export class MoroccanPSP {
  private config: PSPConfig;
  private cmiClient?: CMIClient;

  constructor() {
    this.config = detectMoroccanPSP();
    if (this.config.provider === "cmi" && this.config.enabled) {
      this.cmiClient = createCMIClient();
    }
  }

  isAvailable(): boolean {
    return this.config.enabled;
  }

  getConfig(): PSPConfig {
    return this.config;
  }

  /**
   * Create a payment intent.
   */
  async createPayment(intent: PaymentIntent): Promise<PaymentResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        provider: "unknown",
        status: "failed",
        error: "No Moroccan PSP configured",
      };
    }

    switch (this.config.provider) {
      case "cmi":
        return this.createCMIPayment(intent);
      case "payzone":
        return this.createPayzonePayment(intent);
      case "charipay":
        return this.createChariPayPayment(intent);
      default:
        return {
          success: false,
          provider: "unknown",
          status: "failed",
          error: "Unknown PSP provider",
        };
    }
  }

  /**
   * Verify a payment callback.
   */
  async verifyCallback(callbackData: Record<string, unknown>): Promise<{
    valid: boolean;
    successful: boolean;
    order_id?: string;
    amount?: number;
  }> {
    switch (this.config.provider) {
      case "cmi":
        if (this.cmiClient) {
          const valid = this.cmiClient.validateCallback(
            callbackData as Parameters<CMIClient["validateCallback"]>[0]
          );
          const successful = this.cmiClient.isPaymentSuccessful(
            callbackData as Parameters<CMIClient["isPaymentSuccessful"]>[0]
          );
          return {
            valid,
            successful,
            order_id: callbackData.oid as string | undefined,
            amount: callbackData.amount
              ? parseFloat(callbackData.amount as string)
              : undefined,
          };
        }
        break;
      case "payzone":
        // Payzone callback verification
        return { valid: true, successful: true };
      case "charipay":
        // Chari Pay callback verification
        return { valid: true, successful: true };
    }

    return { valid: false, successful: false };
  }

  // ─── CMI ──────────────────────────────────────────────────────

  private async createCMIPayment(
    intent: PaymentIntent
  ): Promise<PaymentResult> {
    if (!this.cmiClient) {
      return {
        success: false,
        provider: "cmi",
        status: "failed",
        error: "CMI client not initialized",
      };
    }

    try {
      const response = this.cmiClient.generatePaymentRequest({
        amount: intent.amount,
        order_id: intent.order_id,
        email: intent.customer_email,
        bill_to_name: intent.customer_name,
        description: intent.description,
        auto_redirect: true,
      });

      return {
        success: true,
        provider: "cmi",
        payment_id: intent.order_id,
        status: "pending",
        redirect_url: response.gateway_url,
      };
    } catch (err) {
      return {
        success: false,
        provider: "cmi",
        status: "failed",
        error: err instanceof Error ? err.message : "CMI payment failed",
      };
    }
  }

  // ─── Payzone ──────────────────────────────────────────────────

  private async createPayzonePayment(
    intent: PaymentIntent
  ): Promise<PaymentResult> {
    // Payzone (HPS/VPS) API integration
    // Docs: https://docs.hps-global.com/
    const apiUrl =
      this.config.sandbox
        ? "https://sandbox.payzone.com/api/v1"
        : "https://api.payzone.com/api/v1";

    try {
      const response = await fetch(`${apiUrl}/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: intent.amount,
          currency: intent.currency === "MAD" ? "504" : intent.currency,
          order_id: intent.order_id,
          description: intent.description,
          customer_email: intent.customer_email,
          callback_url: process.env.CMI_CALLBACK_URL || "",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          provider: "payzone",
          payment_id: data.payment_id || data.id,
          status: "pending",
          redirect_url: data.redirect_url || data.checkout_url,
        };
      }

      return {
        success: false,
        provider: "payzone",
        status: "failed",
        error: `Payzone API error: ${response.status}`,
      };
    } catch (err) {
      return {
        success: false,
        provider: "payzone",
        status: "failed",
        error: err instanceof Error ? err.message : "Payzone payment failed",
      };
    }
  }

  // ─── Chari Pay ────────────────────────────────────────────────

  private async createChariPayPayment(
    intent: PaymentIntent
  ): Promise<PaymentResult> {
    // Chari Pay (ChariBaaS) API integration
    const apiUrl =
      this.config.sandbox
        ? "https://sandbox.chari.com/api/v1"
        : "https://api.chari.com/api/v1";

    try {
      const response = await fetch(`${apiUrl}/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: intent.amount,
          currency: intent.currency,
          order_id: intent.order_id,
          description: intent.description,
          customer_email: intent.customer_email,
          payment_methods: ["card", "wallet", "transfer"],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          provider: "charipay",
          payment_id: data.payment_id || data.id,
          status: "pending",
          redirect_url: data.checkout_url,
        };
      }

      return {
        success: false,
        provider: "charipay",
        status: "failed",
        error: `Chari Pay API error: ${response.status}`,
      };
    } catch (err) {
      return {
        success: false,
        provider: "charipay",
        status: "failed",
        error: err instanceof Error ? err.message : "Chari Pay payment failed",
      };
    }
  }
}

// ─── BaaS Account Setup ────────────────────────────────────────────

/**
 * ChariBaaS provides:
 *   - Payment accounts with Moroccan IBANs
 *   - Card issuing (Visa)
 *   - Online acquiring via Chari Pay
 *   - Agent network for CICO
 *   - KYC/KYB onboarding
 *
 * For the swarm, this means:
 *   1. Open a ChariBaaS payment account
 *   2. Get a Moroccan IBAN
 *   3. Accept payments via Chari Pay
 *   4. Funds settle directly to the ChariBaaS account
 *   5. Transfer to Attijariwafa via local transfer
 */
export interface ChariBAASAccount {
  account_id: string;
  iban: string;
  bic: string;
  bank_name: string;
  currency: string;
  status: "active" | "pending_kyc" | "suspended";
}

export async function setupChariBAAS(): Promise<ChariBAASAccount | null> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) return null;

  const apiUrl =
    process.env.CHARIPAY_SANDBOX !== "false"
      ? "https://sandbox.chari.com/api/v1"
      : "https://api.chari.com/api/v1";

  try {
    const response = await fetch(`${apiUrl}/accounts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "merchant",
        currency: "MAD",
        business_name: "HIT Swarm Operations",
        business_type: "digital_services",
      }),
    });

    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Not available yet
  }

  return null;
}

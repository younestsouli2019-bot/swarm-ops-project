/**
 * Provider-Agnostic Settlement Adapter
 *
 * Each payment provider implements this interface.
 * The swarm doesn't know which provider it's using —
 * it just says "pay this amount to this destination."
 *
 * Providers:
 *   PayoneerAdapter    — Payoneer SWIFT withdrawal (fallback)
 *   MoroccanPSPAdapter — CMI / Payzone / Chari Pay (primary, when available)
 *   ManualAdapter      — owner executes payment manually
 *
 * Owner action required = adapter is not fully automated.
 * This is NOT a system failure. It's a feature.
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";
import { maskAccount } from "./money-state";

// ─── Adapter Interface ──────────────────────────────────────────────

export type SettlementMode = "automatic" | "semi_automatic" | "manual";

export type ProviderCapability =
  | "withdraw_to_bank"
  | "accept_payments"
  | "process_cards"
  | "send_swift"
  | "local_transfer";

export interface SettlementRequest {
  request_id: string;
  amount: number;
  currency: string;
  source_account: string;
  destination_account: string;
  destination_bank: string;
  destination_bic: string;
  beneficiary_name: string;
  reference: string;
  environment: "production" | "test";
}

export interface SettlementResult {
  success: boolean;
  mode: SettlementMode;
  provider: string;
  reference?: string;
  status: "submitted" | "pending_owner_action" | "rejected" | "error";
  message: string;
  evidence?: Record<string, unknown>;
  owner_action?: {
    type: "manual_bank_transfer" | "login_and_approve" | "fund_account";
    instructions: string;
    deadline?: string;
  };
}

export interface ProviderAdapter {
  name: string;
  mode: SettlementMode;
  capabilities: ProviderCapability[];
  isAvailable(): Promise<boolean>;
  checkEligibility(
    amount: number,
    currency: string
  ): Promise<{ eligible: boolean; reason?: string }>;
  submit(request: SettlementRequest): Promise<SettlementResult>;
  checkStatus(reference: string): Promise<{
    status: "pending" | "processing" | "completed" | "failed";
    details?: string;
  }>;
}

// ─── Payoneer Adapter (Fallback) ───────────────────────────────────

export class PayoneerAdapter implements ProviderAdapter {
  name = "payoneer";
  mode: SettlementMode = "manual";
  capabilities: ProviderCapability[] = [
    "withdraw_to_bank",
    "send_swift",
  ];

  private apiKey: string;
  private userId: string;
  private accountId: string;

  constructor() {
    this.apiKey = process.env.PAYONEER_API_SECRET || "";
    this.userId = process.env.PAYONEER_USER_ID || "";
    this.accountId = process.env.OWNER_PAYONEER_ID || "";
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.apiKey && this.userId && this.accountId);
  }

  async checkEligibility(
    amount: number,
    currency: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!this.apiKey) {
      return {
        eligible: false,
        reason: "Payoneer API credentials not configured",
      };
    }
    if (amount <= 0) {
      return { eligible: false, reason: "Amount must be positive" };
    }
    // In production, call Payoneer API to check balance + eligibility
    return {
      eligible: true,
      reason: "Manual SWIFT withdrawal via Payoneer dashboard",
    };
  }

  async submit(request: SettlementRequest): Promise<SettlementResult> {
    const eligible = await this.checkEligibility(
      request.amount,
      request.currency
    );
    if (!eligible.eligible) {
      return {
        success: false,
        mode: "manual",
        provider: "payoneer",
        status: "pending_owner_action",
        message: eligible.reason || "Not eligible",
        owner_action: {
          type: "login_and_approve",
          instructions: `Login to Payoneer → Withdraw to Bank → Select ${request.destination_bank} → Enter ${request.amount} ${request.currency} → Confirm`,
        },
      };
    }

    // Attempt automated SWIFT via Payoneer API
    try {
      const response = await fetch(
        `https://api.payoneer.com/v2/accounts/${this.accountId}/withdrawals`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: request.amount,
            currency: request.currency,
            destination: {
              type: "bank_transfer",
              account_number: request.destination_account,
              bank_name: request.destination_bank,
              swift_code: request.destination_bic,
              beneficiary_name: request.beneficiary_name,
            },
            reference: request.reference,
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          mode: "automatic",
          provider: "payoneer",
          reference: data.withdrawal_id || data.id,
          status: "submitted",
          message: `Payoneer withdrawal submitted: ${request.amount} ${request.currency}`,
          evidence: {
            payoneer_withdrawal_id: data.withdrawal_id || data.id,
            submitted_at: new Date().toISOString(),
          },
        };
      }
    } catch {
      // API not available
    }

    // Fallback: manual action required
    return {
      success: false,
      mode: "manual",
      provider: "payoneer",
      status: "pending_owner_action",
      message: `Manual Payoneer withdrawal required: ${request.amount} ${request.currency} → ${maskAccount(request.destination_account)}`,
      owner_action: {
        type: "manual_bank_transfer",
        instructions: [
          `Login to Payoneer (${this.userId})`,
          `Go to Withdraw → To Bank Account`,
          `Select destination: ${request.destination_bank} (${request.destination_bic})`,
          `Enter amount: ${request.amount} ${request.currency}`,
          `Reference: ${request.reference}`,
          `Confirm withdrawal`,
          `SWIFT will be sent to ${maskAccount(request.destination_account)}`,
        ].join("\n"),
        deadline: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
    };
  }

  async checkStatus(
    reference: string
  ): Promise<{ status: "pending" | "processing" | "completed" | "failed"; details?: string }> {
    if (!this.apiKey) {
      return { status: "failed", details: "No API credentials" };
    }
    try {
      const response = await fetch(
        `https://api.payoneer.com/v2/accounts/${this.accountId}/withdrawals/${reference}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );
      if (response.ok) {
        const data = await response.json();
        const status = data.status?.toLowerCase() || "pending";
        return {
          status: status === "completed" ? "completed" : status === "failed" ? "failed" : "processing",
          details: data.status,
        };
      }
    } catch {
      // API not available
    }
    return { status: "pending", details: "Manual check required" };
  }
}

// ─── Moroccan PSP Adapter (Primary, when available) ─────────────────

export class MoroccanPSPAdapter implements ProviderAdapter {
  name = "moroccan_psp";
  mode: SettlementMode = "semi_automatic";
  capabilities: ProviderCapability[] = [
    "accept_payments",
    "process_cards",
    "local_transfer",
  ];

  private pspType: "cmi" | "payzone" | "charipay" | "unknown";

  constructor() {
    const psp = process.env.MOROCCAN_PSP || "";
    if (psp === "cmi") this.pspType = "cmi";
    else if (psp === "payzone") this.pspType = "payzone";
    else if (psp === "charipay") this.pspType = "charipay";
    else this.pspType = "unknown";
  }

  async isAvailable(): Promise<boolean> {
    if (this.pspType === "cmi") {
      return !!(process.env.CMI_MERCHANT_ID && process.env.CMI_CLIENT_ID && process.env.CMI_STORE_KEY);
    }
    if (this.pspType === "payzone") {
      return !!(process.env.PAYZONE_API_KEY && process.env.PAYZONE_MERCHANT_ID);
    }
    if (this.pspType === "charipay") {
      return !!(process.env.CHARIPAY_API_KEY && process.env.CHARIPAY_MERCHANT_ID);
    }
    return false;
  }

  async checkEligibility(
    amount: number,
    currency: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (this.pspType === "unknown") {
      return {
        eligible: false,
        reason:
          "No Moroccan PSP configured. Set MOROCCAN_PSP=cmi|payzone|charipay",
      };
    }
    if (currency !== "MAD" && currency !== "USD" && currency !== "EUR") {
      return {
        eligible: false,
        reason: `Moroccan PSP does not support ${currency}`,
      };
    }
    return { eligible: true, reason: `${this.pspType} PSP available` };
  }

  async submit(request: SettlementRequest): Promise<SettlementResult> {
    // Use the MoroccanPSP class for actual payment processing
    try {
      const { MoroccanPSP } = await import("@/lib/payments/moroccan-psp");
      const psp = new MoroccanPSP();
      const result = await psp.createPayment({
        id: request.request_id,
        amount: request.amount,
        currency: request.currency,
        description: `Settlement: ${request.reference}`,
        order_id: request.request_id,
      });

      if (result.success) {
        return {
          success: true,
          mode: "semi_automatic",
          provider: `moroccan_psp_${this.pspType}`,
          reference: result.payment_id,
          status: "submitted",
          message: `Payment submitted via ${this.pspType}`,
          evidence: {
            psp_provider: this.pspType,
            payment_id: result.payment_id,
            submitted_at: new Date().toISOString(),
          },
        };
      }

      return {
        success: false,
        mode: "semi_automatic",
        provider: `moroccan_psp_${this.pspType}`,
        status: "pending_owner_action",
        message: result.error || `Payment requires owner approval`,
        owner_action: {
          type: "login_and_approve",
          instructions: [
            `Login to ${this.pspType.toUpperCase()} merchant dashboard`,
            `Go to Settlements / Withdrawals`,
            `Select destination: Attijariwafa Account (${maskAccount("007810000448200061321372")})`,
            `Confirm settlement of ${request.amount} ${request.currency}`,
            `Reference: ${request.reference}`,
          ].join("\n"),
        },
      };
    } catch {
      return {
        success: false,
        mode: "semi_automatic",
        provider: `moroccan_psp_${this.pspType}`,
        status: "pending_owner_action",
        message: `Moroccan PSP (${this.pspType}) settlement requires owner approval`,
        owner_action: {
          type: "login_and_approve",
          instructions: [
            `Login to ${this.pspType.toUpperCase()} merchant dashboard`,
            `Go to Settlements / Withdrawals`,
            `Select destination: Attijariwafa Account (${maskAccount("007810000448200061321372")})`,
            `Confirm settlement of ${request.amount} ${request.currency}`,
            `Reference: ${request.reference}`,
          ].join("\n"),
        },
      };
    }
  }

  async checkStatus(
    reference: string
  ): Promise<{ status: "pending" | "processing" | "completed" | "failed"; details?: string }> {
    return { status: "pending", details: "Check PSP dashboard" };
  }
}

// ─── Manual Adapter (Always Available) ──────────────────────────────

export class ManualAdapter implements ProviderAdapter {
  name = "manual";
  mode: SettlementMode = "manual";
  capabilities: ProviderCapability[] = [
    "withdraw_to_bank",
    "send_swift",
    "local_transfer",
  ];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async checkEligibility(
    amount: number,
    currency: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    return { eligible: true, reason: "Manual payment always available" };
  }

  async submit(request: SettlementRequest): Promise<SettlementResult> {
    return {
      success: false,
      mode: "manual",
      provider: "manual",
      status: "pending_owner_action",
      message: `Manual payment required: ${request.amount} ${request.currency} → ${maskAccount(request.destination_account)}`,
      owner_action: {
        type: "manual_bank_transfer",
        instructions: [
          `Transfer ${request.amount} ${request.currency} to:`,
          `  Bank: ${request.destination_bank}`,
          `  BIC: ${request.destination_bic}`,
          `  Account: ${maskAccount(request.destination_account)}`,
          `  Beneficiary: ${request.beneficiary_name}`,
          `  Reference: ${request.reference}`,
        ].join("\n"),
      },
    };
  }

  async checkStatus(
    reference: string
  ): Promise<{ status: "pending" | "processing" | "completed" | "failed"; details?: string }> {
    return { status: "pending", details: "Manual check required" };
  }
}

// ─── Adapter Registry ───────────────────────────────────────────────

export function getAvailableAdapters(): ProviderAdapter[] {
  return [new PayoneerAdapter(), new MoroccanPSPAdapter(), new ManualAdapter()];
}

export function getBestAdapter(
  adapters: ProviderAdapter[] = getAvailableAdapters()
): ProviderAdapter {
  // Priority: automatic > semi_automatic > manual
  const sorted = adapters.sort((a, b) => {
    const modeOrder: Record<SettlementMode, number> = {
      automatic: 0,
      semi_automatic: 1,
      manual: 2,
    };
    return modeOrder[a.mode] - modeOrder[b.mode];
  });
  return sorted[0];
}

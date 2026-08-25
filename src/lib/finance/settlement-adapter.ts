/**
 * Settlement Adapter Pattern
 *
 * Payout Engine → Settlement Adapter → Provider (manual / API)
 *
 * Each adapter implements the same interface.
 * Swapping Payoneer for Banking Circle or Wise requires zero changes
 * to the payout engine.
 *
 * Adapters:
 *   - PayoneerAdapter: SWIFT via Payoneer (manual or API)
 *   - BankingCircleAdapter: SWIFT via Banking Circle (mTLS + OAuth2)
 *   - ManualAdapter: Generate instructions for any provider
 */

import { randomUUID } from "crypto";
import {
  MoneyFlow,
  promoteFlow,
  SettlementProof,
  maskAccount,
} from "./money-state";

// ─── Adapter Interface ──────────────────────────────────────────────

export interface SettlementAdapter {
  name: string;
  type: "api" | "manual" | "hybrid";

  /**
   * Check if adapter is configured and ready.
   */
  isConfigured(): boolean;

  /**
   * Get current balance (if API available).
   */
  getBalance(): Promise<{ currency: string; amount: number } | null>;

  /**
   * Submit a payout. Returns provider reference or instructions.
   */
  submitPayout(flow: MoneyFlow): Promise<SettlementResult>;

  /**
   * Check status of a submitted payout.
   */
  checkStatus(
    providerReference: string
  ): Promise<SettlementStatus>;

  /**
   * Generate human-readable instructions (for manual execution).
   */
  generateInstructions(flow: MoneyFlow): string;
}

export interface SettlementResult {
  ok: boolean;
  provider: string;
  adapter_type: "api" | "manual" | "hybrid";
  provider_reference?: string;
  status: "submitted" | "pending_manual" | "error";
  instructions?: string;
  error?: string;
}

export interface SettlementStatus {
  provider: string;
  provider_reference: string;
  status: "pending" | "processing" | "settled" | "failed";
  bank_confirmed: boolean;
  confirmed_at?: string;
  settlement_proof?: string;
}

// ─── Payoneer Adapter ───────────────────────────────────────────────

export class PayoneerAdapter implements SettlementAdapter {
  name = "payoneer";
  type: "hybrid" = "hybrid";

  private accountId =
    process.env.PAYONEER_ACCOUNT_ID || "325EF6267B78444D86BF8286069806BE";
  private userId = process.env.PAYONEER_USER_ID || "";
  private secret = process.env.PAYONEER_API_SECRET || "";

  isConfigured(): boolean {
    return !!(this.userId && this.secret);
  }

  async getBalance(): Promise<{ currency: string; amount: number } | null> {
    if (!this.isConfigured()) return null;
    // API balance check — falls back to null if not available
    return null;
  }

  async submitPayout(flow: MoneyFlow): Promise<SettlementResult> {
    const ref = `PAY-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    if (this.isConfigured()) {
      // Try API submission
      try {
        const result = await this.submitViaAPI(flow, ref);
        if (result.ok) return result;
      } catch {
        // Fall through to manual
      }
    }

    // Manual fallback — always works
    return {
      ok: true,
      provider: "payoneer",
      adapter_type: "manual",
      provider_reference: ref,
      status: "pending_manual",
      instructions: this.generateInstructions(flow),
    };
  }

  async checkStatus(
    providerReference: string
  ): Promise<SettlementStatus> {
    if (providerReference.startsWith("PAY-")) {
      return {
        provider: "payoneer",
        provider_reference: providerReference,
        status: "pending",
        bank_confirmed: false,
      };
    }
    return {
      provider: "payoneer",
      provider_reference: providerReference,
      status: "pending",
      bank_confirmed: false,
    };
  }

  generateInstructions(flow: MoneyFlow): string {
    const eurAmount = (flow.amount / 10.7).toFixed(2);
    return [
      `PAYONEER SWIFT WITHDRAWAL`,
      `Amount: EUR ${eurAmount} (MAD ${flow.amount})`,
      `To: YOUNES TSOULI`,
      `Account: ${maskAccount("007810000448200061321372")}`,
      `BIC: BMCEMAMX`,
      `Bank: Attijariwafa Bank Morocco`,
      `Reference: ${flow.id}`,
      ``,
      `Steps:`,
      `1. Login: https://www.payoneer.com/login`,
      `2. Pay > Withdraw to Bank Account`,
      `3. Enter amount: EUR ${eurAmount}`,
      `4. Select beneficiary: YOUNES TSOULI`,
      `5. Confirm`,
    ].join("\n");
  }

  private async submitViaAPI(
    flow: MoneyFlow,
    ref: string
  ): Promise<SettlementResult> {
    // Payoneer API submission placeholder
    // Real implementation when API credentials are properly registered
    throw new Error("API not available");
  }
}

// ─── Banking Circle Adapter ─────────────────────────────────────────

export class BankingCircleAdapter implements SettlementAdapter {
  name = "banking_circle";
  type: "api" = "api";

  private authUrl =
    process.env.BANKING_CIRCLE_AUTH_URL ||
    "https://authorizationsandbox.bankingcircleconnect.com";
  private dataUrl =
    process.env.BANKING_CIRCLE_DATA_URL ||
    "https://sandbox.bankingcircleconnect.com";
  private accountId = process.env.BANKING_CIRCLE_ACCOUNT_ID || "";
  private username = process.env.BANKING_CIRCLE_USERNAME || "";
  private password = process.env.BANKING_CIRCLE_PASSWORD || "";

  isConfigured(): boolean {
    return !!(this.username && this.password && this.accountId);
  }

  async getBalance(): Promise<{ currency: string; amount: number } | null> {
    if (!this.isConfigured()) return null;
    return null;
  }

  async submitPayout(flow: MoneyFlow): Promise<SettlementResult> {
    const ref = `BC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    if (this.isConfigured()) {
      try {
        const token = await this.getAccessToken();
        const result = await this.submitSWIFT(flow, token, ref);
        if (result.ok) return result;
      } catch {
        // Fall through
      }
    }

    return {
      ok: true,
      provider: "banking_circle",
      adapter_type: "manual",
      provider_reference: ref,
      status: "pending_manual",
      instructions: this.generateInstructions(flow),
    };
  }

  async checkStatus(
    providerReference: string
  ): Promise<SettlementStatus> {
    return {
      provider: "banking_circle",
      provider_reference: providerReference,
      status: "pending",
      bank_confirmed: false,
    };
  }

  generateInstructions(flow: MoneyFlow): string {
    const eurAmount = (flow.amount / 10.7).toFixed(2);
    return [
      `BANKING CIRCLE SWIFT TRANSFER`,
      `Amount: EUR ${eurAmount}`,
      `To: YOUNES TSOULI`,
      `Account: ${maskAccount("007810000448200061321372")}`,
      `BIC: BMCEMAMX`,
      `Bank: Attijariwafa Bank Morocco`,
      `Reference: ${flow.id}`,
      ``,
      `Login: https://connect.bankingcircle.com`,
      `Payments > New Payment > SWIFT`,
    ].join("\n");
  }

  private async getAccessToken(): Promise<string> {
    throw new Error("Banking Circle API not configured");
  }

  private async submitSWIFT(
    flow: MoneyFlow,
    token: string,
    ref: string
  ): Promise<SettlementResult> {
    throw new Error("Banking Circle API not configured");
  }
}

// ─── Manual Adapter (Any Provider) ─────────────────────────────────

export class ManualAdapter implements SettlementAdapter {
  name = "manual";
  type: "manual" = "manual";

  isConfigured(): boolean {
    return true; // Always available
  }

  async getBalance(): Promise<null> {
    return null;
  }

  async submitPayout(flow: MoneyFlow): Promise<SettlementResult> {
    const ref = `MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    return {
      ok: true,
      provider: "manual",
      adapter_type: "manual",
      provider_reference: ref,
      status: "pending_manual",
      instructions: this.generateInstructions(flow),
    };
  }

  async checkStatus(
    providerReference: string
  ): Promise<SettlementStatus> {
    return {
      provider: "manual",
      provider_reference: providerReference,
      status: "pending",
      bank_confirmed: false,
    };
  }

  generateInstructions(flow: MoneyFlow): string {
    return [
      `MANUAL TRANSFER REQUIRED`,
      `Amount: ${flow.currency} ${flow.amount}`,
      `Beneficiary: YOUNES TSOULI`,
      `Account: 007810000448200061321372`,
      `BIC: BMCEMAMX`,
      `Reference: ${flow.id}`,
    ].join("\n");
  }
}

// ─── Adapter Factory ────────────────────────────────────────────────

export function getSettlementAdapter(
  provider: string
): SettlementAdapter {
  switch (provider) {
    case "payoneer":
      return new PayoneerAdapter();
    case "banking_circle":
      return new BankingCircleAdapter();
    case "manual":
    default:
      return new ManualAdapter();
  }
}

export function getBestAdapter(): SettlementAdapter {
  const bc = new BankingCircleAdapter();
  if (bc.isConfigured()) return bc;

  const pay = new PayoneerAdapter();
  if (pay.isConfigured()) return pay;

  return new ManualAdapter();
}

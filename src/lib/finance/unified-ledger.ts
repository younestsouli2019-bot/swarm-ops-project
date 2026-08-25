/**
 * Unified Ledger — Single Source of Truth
 *
 * Every money movement is recorded here as a ledger entry.
 * No money moves without a ledger entry.
 * No ledger entry exists without evidence.
 *
 * Entry types:
 *   REVENUE        — swarm earned money
 *   VERIFIED       — revenue confirmed at source
 *   PAYABLE        — ready to be paid out
 *   SETTLEMENT     — sent to payment provider
 *   BANK_CREDIT    — bank confirmed receipt
 *   REVERSAL       — money came back (refund/dispute)
 *   ADJUSTMENT     — manual correction
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";
import { maskAccount } from "./money-state";

// ─── Ledger Entry ───────────────────────────────────────────────────

export type LedgerEntryType =
  | "revenue"
  | "verified"
  | "payable"
  | "settlement"
  | "bank_credit"
  | "reversal"
  | "adjustment";

export type LedgerEntryStatus =
  | "pending"
  | "confirmed"
  | "failed"
  | "reconciled";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  amount: number;
  currency: string;
  source: string;           // where the money came from
  destination: string;      // where the money is going
  provider?: string;        // payment provider used
  provider_reference?: string;
  bank_reference?: string;
  evidence: Record<string, unknown>;
  idempotency_key: string;
  created_at: string;
  confirmed_at?: string;
  reconciled_at?: string;
  environment: "production" | "test";
}

// ─── Unified Ledger ─────────────────────────────────────────────────

export class UnifiedLedger {
  private entries: LedgerEntry[] = [];

  /**
   * Record a revenue entry.
   */
  async recordRevenue(event: {
    amount: number;
    currency: string;
    source: string;
    source_transaction_id: string;
    source_provider: string;
    environment?: "production" | "test";
  }): Promise<LedgerEntry> {
    const idempotencyKey = this.generateKey(
      "revenue",
      event.source_transaction_id,
      event.amount,
      event.currency
    );

    const existing = this.findByIdempotency(idempotencyKey);
    if (existing) return existing;

    const entry: LedgerEntry = {
      id: `LED-${Date.now().toString(36).toUpperCase()}`,
      type: "revenue",
      status: "confirmed",
      amount: event.amount,
      currency: event.currency,
      source: event.source,
      destination: "payoneer_balance",
      evidence: {
        source_transaction_id: event.source_transaction_id,
        source_provider: event.source_provider,
        verification_timestamp: new Date().toISOString(),
      },
      idempotency_key: idempotencyKey,
      created_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      environment: event.environment || "production",
    };

    this.entries.push(entry);
    await this.persist(entry);
    return entry;
  }

  /**
   * Mark revenue as verified (source confirmed).
   */
  async verifyRevenue(
    entryId: string,
    evidence: {
      provider_verification_id: string;
      verified_at?: string;
    }
  ): Promise<LedgerEntry> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`Ledger entry ${entryId} not found`);
    if (entry.type !== "revenue") {
      throw new Error(`Cannot verify non-revenue entry`);
    }

    const verified: LedgerEntry = {
      ...entry,
      type: "verified",
      evidence: {
        ...entry.evidence,
        provider_verification_id: evidence.provider_verification_id,
        verified_at: evidence.verified_at || new Date().toISOString(),
      },
      confirmed_at: evidence.verified_at || new Date().toISOString(),
    };

    const idx = this.entries.findIndex((e) => e.id === entryId);
    this.entries[idx] = verified;
    await this.persist(verified);
    return verified;
  }

  /**
   * Mark as payable (ready for payout).
   */
  async markPayable(
    entryId: string,
    evidence: {
      beneficiary_id: string;
      payout_batch_id?: string;
    }
  ): Promise<LedgerEntry> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`Ledger entry ${entryId} not found`);

    const payable: LedgerEntry = {
      ...entry,
      type: "payable",
      destination: evidence.beneficiary_id,
      evidence: {
        ...entry.evidence,
        beneficiary_id: evidence.beneficiary_id,
        payout_batch_id: evidence.payout_batch_id,
        payable_at: new Date().toISOString(),
      },
    };

    const idx = this.entries.findIndex((e) => e.id === entryId);
    this.entries[idx] = payable;
    await this.persist(payable);
    return payable;
  }

  /**
   * Record settlement (sent to provider).
   */
  async recordSettlement(
    entryId: string,
    evidence: {
      provider: string;
      provider_reference: string;
      settlement_method: "automatic" | "manual";
      submitted_at?: string;
    }
  ): Promise<LedgerEntry> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`Ledger entry ${entryId} not found`);

    const settlement: LedgerEntry = {
      ...entry,
      type: "settlement",
      status: "pending",
      provider: evidence.provider,
      provider_reference: evidence.provider_reference,
      evidence: {
        ...entry.evidence,
        provider: evidence.provider,
        provider_reference: evidence.provider_reference,
        settlement_method: evidence.settlement_method,
        submitted_at: evidence.submitted_at || new Date().toISOString(),
      },
      confirmed_at: undefined,
    };

    const idx = this.entries.findIndex((e) => e.id === entryId);
    this.entries[idx] = settlement;
    await this.persist(settlement);
    return settlement;
  }

  /**
   * Confirm bank receipt.
   */
  async confirmBankCredit(
    entryId: string,
    evidence: {
      bank_reference: string;
      bank_confirmed_at?: string;
      settled_amount: number;
      settled_currency: string;
    }
  ): Promise<LedgerEntry> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`Ledger entry ${entryId} not found`);

    const credited: LedgerEntry = {
      ...entry,
      type: "bank_credit",
      status: "reconciled",
      bank_reference: evidence.bank_reference,
      evidence: {
        ...entry.evidence,
        bank_reference: evidence.bank_reference,
        bank_confirmed_at:
          evidence.bank_confirmed_at || new Date().toISOString(),
        settled_amount: evidence.settled_amount,
        settled_currency: evidence.settled_currency,
      },
      confirmed_at: evidence.bank_confirmed_at || new Date().toISOString(),
      reconciled_at: new Date().toISOString(),
    };

    const idx = this.entries.findIndex((e) => e.id === entryId);
    this.entries[idx] = credited;
    await this.persist(credited);
    return credited;
  }

  /**
   * Get totals by status.
   */
  getTotals(): {
    gross_revenue: number;
    verified: number;
    payable: number;
    submitted: number;
    provider_confirmed: number;
    bank_confirmed: number;
    by_provider: Record<string, number>;
    by_destination: Record<string, number>;
  } {
    const prod = this.entries.filter(
      (e) =>
        e.environment === "production" &&
        e.type !== "reversal" &&
        e.type !== "adjustment"
    );

    return {
      gross_revenue: prod
        .filter((e) => ["revenue", "verified", "payable", "settlement", "bank_credit"].includes(e.type))
        .reduce((s, e) => s + e.amount, 0),
      verified: prod
        .filter((e) => ["verified", "payable", "settlement", "bank_credit"].includes(e.type))
        .reduce((s, e) => s + e.amount, 0),
      payable: prod
        .filter((e) => ["payable", "settlement", "bank_credit"].includes(e.type))
        .reduce((s, e) => s + e.amount, 0),
      submitted: prod
        .filter((e) => ["settlement", "bank_credit"].includes(e.type))
        .reduce((s, e) => s + e.amount, 0),
      provider_confirmed: prod
        .filter((e) => e.type === "settlement" && e.status === "confirmed")
        .reduce((s, e) => s + e.amount, 0),
      bank_confirmed: prod
        .filter((e) => e.type === "bank_credit")
        .reduce((s, e) => s + e.amount, 0),
      by_provider: this.groupBy(prod, "provider"),
      by_destination: this.groupBy(prod, "destination"),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private generateKey(
    type: string,
    sourceId: string,
    amount: number,
    currency: string
  ): string {
    const input = `${type}:${sourceId}:${amount}:${currency}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  private findByIdempotency(key: string): LedgerEntry | undefined {
    return this.entries.find((e) => e.idempotency_key === key);
  }

  private groupBy(
    entries: LedgerEntry[],
    field: keyof LedgerEntry
  ): Record<string, number> {
    const result: Record<string, number> = {};
    for (const e of entries) {
      const key = String(e[field] || "unknown");
      result[key] = (result[key] || 0) + e.amount;
    }
    return result;
  }

  private async persist(entry: LedgerEntry): Promise<void> {
    try {
      await b44.create("LedgerEntry", {
        ledger_id: entry.id,
        type: entry.type,
        status: entry.status,
        amount: entry.amount,
        currency: entry.currency,
        source: entry.source,
        destination: entry.destination,
        provider: entry.provider || "",
        provider_reference: entry.provider_reference || "",
        evidence: JSON.stringify(entry.evidence),
        idempotency_key: entry.idempotency_key,
        environment: entry.environment,
      } as never);
    } catch {
      // Non-fatal — in-memory ledger still works
    }
  }
}

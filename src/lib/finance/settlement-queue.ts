/**
 * Settlement Queue
 *
 * The queue decides:
 *   1. Which provider to use
 *   2. Whether settlement is automatic or requires owner action
 *   3. How to track status
 *
 * Owner action required = adapter is not fully automated.
 * This is NOT a system failure. It's a feature.
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";
import {
  ProviderAdapter,
  SettlementRequest,
  SettlementResult,
  getAvailableAdapters,
  getBestAdapter,
} from "./provider-adapter";
import { UnifiedLedger } from "./unified-ledger";
import { maskAccount } from "./money-state";

// ─── Queue Item ─────────────────────────────────────────────────────

export type QueueStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "completed"
  | "failed"
  | "owner_action_required";

export interface SettlementQueueItem {
  id: string;
  ledger_entry_id: string;
  amount: number;
  currency: string;
  source: string;
  destination: string;
  destination_bank: string;
  destination_bic: string;
  beneficiary_name: string;
  reference: string;
  provider: string;
  mode: "automatic" | "semi_automatic" | "manual";
  status: QueueStatus;
  provider_reference?: string;
  owner_action?: {
    type: string;
    instructions: string;
    deadline?: string;
  };
  created_at: string;
  submitted_at?: string;
  completed_at?: string;
  failed_at?: string;
  error?: string;
  environment: "production" | "test";
}

// ─── Settlement Queue ───────────────────────────────────────────────

export class SettlementQueue {
  private items: SettlementQueueItem[] = [];
  private ledger: UnifiedLedger;

  constructor(ledger: UnifiedLedger) {
    this.ledger = ledger;
  }

  /**
   * Add a settlement request to the queue.
   * Automatically selects the best provider.
   */
  async enqueue(request: {
    ledger_entry_id: string;
    amount: number;
    currency: string;
    source: string;
    destination: string;
    destination_bank: string;
    destination_bic: string;
    beneficiary_name: string;
    reference: string;
    environment?: "production" | "test";
  }): Promise<SettlementQueueItem> {
    const adapters = getAvailableAdapters();
    const available: ProviderAdapter[] = [];

    for (const adapter of adapters) {
      const isAvail = await adapter.isAvailable();
      if (isAvail) {
        const eligible = await adapter.checkEligibility(
          request.amount,
          request.currency
        );
        if (eligible.eligible) {
          available.push(adapter);
        }
      }
    }

    if (available.length === 0) {
      throw new Error(
        "No payment provider available for this settlement"
      );
    }

    const best = getBestAdapter(available);

    const item: SettlementQueueItem = {
      id: `SQ-${Date.now().toString(36).toUpperCase()}`,
      ledger_entry_id: request.ledger_entry_id,
      amount: request.amount,
      currency: request.currency,
      source: request.source,
      destination: request.destination,
      destination_bank: request.destination_bank,
      destination_bic: request.destination_bic,
      beneficiary_name: request.beneficiary_name,
      reference: request.reference,
      provider: best.name,
      mode: best.mode,
      status: "pending",
      created_at: new Date().toISOString(),
      environment: request.environment || "production",
    };

    this.items.push(item);
    await this.persist(item);
    return item;
  }

  /**
   * Process the next item in the queue.
   */
  async processNext(): Promise<SettlementQueueItem | null> {
    const next = this.items.find((i) => i.status === "pending");
    if (!next) return null;

    const adapters = getAvailableAdapters();
    const adapter = adapters.find((a) => a.name === next.provider);
    if (!adapter) {
      next.status = "failed";
      next.error = `Provider ${next.provider} not found`;
      next.failed_at = new Date().toISOString();
      await this.persist(next);
      return next;
    }

    const request: SettlementRequest = {
      request_id: next.id,
      amount: next.amount,
      currency: next.currency,
      source_account: next.source,
      destination_account: next.destination,
      destination_bank: next.destination_bank,
      destination_bic: next.destination_bic,
      beneficiary_name: next.beneficiary_name,
      reference: next.reference,
      environment: next.environment,
    };

    try {
      const result = await adapter.submit(request);

      if (result.success) {
        next.status = "submitted";
        next.submitted_at = new Date().toISOString();
        next.provider_reference = result.reference;

        // Record in ledger
        await this.ledger.recordSettlement(next.ledger_entry_id, {
          provider: next.provider,
          provider_reference: result.reference || next.id,
          settlement_method: next.mode,
        });
      } else if (result.status === "pending_owner_action") {
        next.status = "owner_action_required";
        next.owner_action = result.owner_action;
      } else {
        next.status = "failed";
        next.error = result.message;
        next.failed_at = new Date().toISOString();
      }
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : "Unknown error";
      next.failed_at = new Date().toISOString();
    }

    await this.persist(next);
    return next;
  }

  /**
   * Process all pending items.
   */
  async processAll(): Promise<{
    submitted: number;
    owner_action_required: number;
    failed: number;
    completed: number;
  }> {
    const results = {
      submitted: 0,
      owner_action_required: 0,
      failed: 0,
      completed: 0,
    };

    while (true) {
      const item = this.items.find((i) => i.status === "pending");
      if (!item) break;

      const processed = await this.processNext();
      if (!processed) break;

      if (processed.status === "submitted") results.submitted++;
      else if (processed.status === "owner_action_required") results.owner_action_required++;
      else if (processed.status === "failed") results.failed++;
      else if (processed.status === "completed") results.completed++;
    }

    return results;
  }

  /**
   * Check status of all submitted items.
   */
  async checkStatuses(): Promise<void> {
    const adapters = getAvailableAdapters();

    for (const item of this.items) {
      if (item.status !== "submitted" && item.status !== "processing") {
        continue;
      }
      if (!item.provider_reference) continue;

      const adapter = adapters.find((a) => a.name === item.provider);
      if (!adapter) continue;

      try {
        const status = await adapter.checkStatus(item.provider_reference);
        if (status.status === "completed") {
          item.status = "completed";
          item.completed_at = new Date().toISOString();
          await this.ledger.confirmBankCredit(item.ledger_entry_id, {
            bank_reference: item.provider_reference,
            settled_amount: item.amount,
            settled_currency: item.currency,
          });
        } else if (status.status === "failed") {
          item.status = "failed";
          item.error = status.details || "Payment failed";
          item.failed_at = new Date().toISOString();
        }
        await this.persist(item);
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Get queue summary.
   */
  getSummary(): {
    total: number;
    pending: number;
    submitted: number;
    processing: number;
    completed: number;
    failed: number;
    owner_action_required: number;
    by_provider: Record<string, number>;
    by_mode: Record<string, number>;
    total_amount_by_status: Record<string, number>;
  } {
    const prod = this.items.filter(
      (i) => i.environment === "production"
    );

    return {
      total: prod.length,
      pending: prod.filter((i) => i.status === "pending").length,
      submitted: prod.filter((i) => i.status === "submitted").length,
      processing: prod.filter((i) => i.status === "processing").length,
      completed: prod.filter((i) => i.status === "completed").length,
      failed: prod.filter((i) => i.status === "failed").length,
      owner_action_required: prod.filter(
        (i) => i.status === "owner_action_required"
      ).length,
      by_provider: this.groupBy(prod, "provider"),
      by_mode: this.groupBy(prod, "mode"),
      total_amount_by_status: this.amountByStatus(prod),
    };
  }

  /**
   * Get items requiring owner action.
   */
  getOwnerActions(): SettlementQueueItem[] {
    return this.items.filter(
      (i) =>
        i.status === "owner_action_required" &&
        i.environment === "production"
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private groupBy(
    items: SettlementQueueItem[],
    field: keyof SettlementQueueItem
  ): Record<string, number> {
    const result: Record<string, number> = {};
    for (const i of items) {
      const key = String(i[field] || "unknown");
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }

  private amountByStatus(
    items: SettlementQueueItem[]
  ): Record<string, number> {
    const result: Record<string, number> = {};
    for (const i of items) {
      result[i.status] = (result[i.status] || 0) + i.amount;
    }
    return result;
  }

  private async persist(item: SettlementQueueItem): Promise<void> {
    try {
      await b44.create("SettlementQueue", {
        queue_id: item.id,
        ledger_entry_id: item.ledger_entry_id,
        amount: item.amount,
        currency: item.currency,
        provider: item.provider,
        mode: item.mode,
        status: item.status,
        provider_reference: item.provider_reference || "",
        owner_action: item.owner_action
          ? JSON.stringify(item.owner_action)
          : "",
        environment: item.environment,
      } as never);
    } catch {
      // Non-fatal
    }
  }
}

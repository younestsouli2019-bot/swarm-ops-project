/**
 * Settlement Retry Engine
 *
 * Automatically retries failed settlements with exponential backoff.
 * Tracks retry count and max retries per provider.
 *
 * Retry schedule:
 *   Attempt 1: immediate
 *   Attempt 2: 5 minutes
 *   Attempt 3: 30 minutes
 *   Attempt 4: 2 hours
 *   Attempt 5: 8 hours (max)
 */

import { b44 } from "@/lib/base44";
import {
  getAvailableAdapters,
  SettlementRequest,
} from "./provider-adapter";

// ─── Retry Config ───────────────────────────────────────────────────

interface RetryConfig {
  maxRetries: number;
  backoffMs: number[];
  maxBackoffMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  backoffMs: [0, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 8 * 60 * 60 * 1000],
  maxBackoffMs: 8 * 60 * 60 * 1000,
};

// ─── Retry Item ─────────────────────────────────────────────────────

export interface RetryItem {
  id: string;
  queue_item_id: string;
  provider: string;
  attempt: number;
  max_retries: number;
  last_attempt_at: string;
  next_retry_at: string;
  backoff_ms: number;
  status: "pending" | "retrying" | "succeeded" | "exhausted";
  errors: string[];
  request: SettlementRequest;
}

// ─── Retry Engine ───────────────────────────────────────────────────

export class SettlementRetryEngine {
  private config: RetryConfig;
  private items: RetryItem[] = [];

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Add a failed settlement to the retry queue.
   */
  async addToRetry(
    queueItemId: string,
    provider: string,
    request: SettlementRequest,
    error: string
  ): Promise<RetryItem> {
    const existing = this.items.find(
      (i) => i.queue_item_id === queueItemId
    );
    if (existing) {
      existing.errors.push(error);
      existing.attempt++;
      existing.last_attempt_at = new Date().toISOString();
      existing.next_retry_at = this.calculateNextRetry(existing.attempt);
      existing.status = existing.attempt >= this.config.maxRetries
        ? "exhausted"
        : "pending";
      await this.persist(existing);
      return existing;
    }

    const item: RetryItem = {
      id: `RETRY-${Date.now().toString(36).toUpperCase()}`,
      queue_item_id: queueItemId,
      provider,
      attempt: 1,
      max_retries: this.config.maxRetries,
      last_attempt_at: new Date().toISOString(),
      next_retry_at: this.calculateNextRetry(1),
      backoff_ms: this.config.backoffMs[1] || 0,
      status: "pending",
      errors: [error],
      request,
    };

    this.items.push(item);
    await this.persist(item);
    return item;
  }

  /**
   * Process all pending retries that are due.
   */
  async processRetries(): Promise<{
    retried: number;
    succeeded: number;
    failed: number;
    exhausted: number;
  }> {
    const results = { retried: 0, succeeded: 0, failed: 0, exhausted: 0 };
    const now = Date.now();

    for (const item of this.items) {
      if (item.status !== "pending") continue;
      if (new Date(item.next_retry_at).getTime() > now) continue;

      // Find the adapter
      const adapters = getAvailableAdapters();
      const adapter = adapters.find((a) => a.name === item.provider);
      if (!adapter) {
        item.status = "exhausted";
        item.errors.push(`Provider ${item.provider} not found`);
        results.exhausted++;
        await this.persist(item);
        continue;
      }

      // Retry
      item.status = "retrying";
      item.attempt++;
      item.last_attempt_at = new Date().toISOString();

      try {
        const result = await adapter.submit(item.request);

        if (result.success) {
          item.status = "succeeded";
          results.succeeded++;
        } else if (item.attempt >= this.config.maxRetries) {
          item.status = "exhausted";
          item.errors.push(result.message);
          results.exhausted++;
        } else {
          item.status = "pending";
          item.next_retry_at = this.calculateNextRetry(item.attempt);
          item.backoff_ms =
            this.config.backoffMs[item.attempt] || this.config.maxBackoffMs;
          results.retried++;
        }
      } catch (err) {
        item.errors.push(
          err instanceof Error ? err.message : "Unknown error"
        );
        if (item.attempt >= this.config.maxRetries) {
          item.status = "exhausted";
          results.exhausted++;
        } else {
          item.status = "pending";
          item.next_retry_at = this.calculateNextRetry(item.attempt);
          results.retried++;
        }
      }

      await this.persist(item);
    }

    return results;
  }

  /**
   * Get retry status summary.
   */
  getSummary(): {
    total: number;
    pending: number;
    retrying: number;
    succeeded: number;
    exhausted: number;
    next_retry?: string;
  } {
    const pending = this.items.filter((i) => i.status === "pending");
    return {
      total: this.items.length,
      pending: pending.length,
      retrying: this.items.filter((i) => i.status === "retrying").length,
      succeeded: this.items.filter((i) => i.status === "succeeded").length,
      exhausted: this.items.filter((i) => i.status === "exhausted").length,
      next_retry:
        pending.length > 0
          ? pending.sort(
              (a, b) =>
                new Date(a.next_retry_at).getTime() -
                new Date(b.next_retry_at).getTime()
            )[0].next_retry_at
          : undefined,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private calculateNextRetry(attempt: number): string {
    const backoff =
      this.config.backoffMs[attempt] || this.config.maxBackoffMs;
    return new Date(Date.now() + backoff).toISOString();
  }

  private async persist(item: RetryItem): Promise<void> {
    try {
      await b44.create("SettlementRetry", {
        retry_id: item.id,
        queue_item_id: item.queue_item_id,
        provider: item.provider,
        attempt: item.attempt,
        max_retries: item.max_retries,
        status: item.status,
        next_retry_at: item.next_retry_at,
        errors: JSON.stringify(item.errors),
        environment: "production",
      } as never);
    } catch {
      // Non-fatal
    }
  }
}

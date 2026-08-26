/**
 * Duplicate Prevention — Idempotency Guard
 *
 * Prevents the same payout from being executed twice.
 * Uses a combination of batch_id + reference as idempotency key.
 * Keys expire after 24 hours (payouts can be retried after that).
 */

// ─── State ──────────────────────────────────────────────────────────

const executedPayouts = new Map<string, { executed_at: string; result: string }>();
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Cleanup ────────────────────────────────────────────────────────

function cleanup(): void {
  const now = Date.now();
  for (const [key, entry] of executedPayouts) {
    if (new Date(entry.executed_at).getTime() + EXPIRY_MS < now) {
      executedPayouts.delete(key);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanup, 10 * 60 * 1000);

// ─── Check / Register ───────────────────────────────────────────────

export function isDuplicatePayout(batchId: string, reference: string): boolean {
  const key = `${batchId}:${reference}`;
  return executedPayouts.has(key);
}

export function registerPayout(batchId: string, reference: string, result: string): void {
  const key = `${batchId}:${reference}`;
  executedPayouts.set(key, {
    executed_at: new Date().toISOString(),
    result,
  });
}

export function getPayoutHistory(): Array<{
  key: string;
  executed_at: string;
  result: string;
}> {
  cleanup();
  return Array.from(executedPayouts.entries()).map(([key, value]) => ({
    key,
    ...value,
  }));
}

export function getDuplicateStats(): {
  total_executed: number;
  keys_active: number;
} {
  cleanup();
  return {
    total_executed: executedPayouts.size,
    keys_active: executedPayouts.size,
  };
}

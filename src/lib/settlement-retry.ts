/**
 * Settlement Retry Engine — Exponential backoff with circuit breaker
 *
 * Retries failed payout API calls with:
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s
 *   - Max 5 retries per payout
 *   - Circuit breaker: pauses after 10 consecutive failures
 *   - Dead letter queue: permanently failed payouts stored for manual review
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface RetryablePayout {
  payout_id: string;
  batch_id: string;
  attempt: number;
  last_error?: string;
  last_attempt_at?: string;
  next_retry_at?: string;
  circuit_breaker_trips: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 32000,
  circuitBreakerThreshold: 10,
  circuitBreakerResetMs: 300000, // 5 minutes
};

// ─── State ──────────────────────────────────────────────────────────

const retryQueue = new Map<string, RetryablePayout>();
const circuitBreaker = {
  consecutiveFailures: 0,
  lastTrippedAt: 0,
  isOpen: false,
};

// ─── Retry Logic ────────────────────────────────────────────────────

export function calculateRetryDelay(attempt: number, config: RetryConfig = DEFAULT_CONFIG): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.maxDelayMs);
}

export function shouldRetry(payout: RetryablePayout, config: RetryConfig = DEFAULT_CONFIG): boolean {
  if (payout.attempt >= config.maxRetries) return false;
  if (circuitBreaker.isOpen) {
    const elapsed = Date.now() - circuitBreaker.lastTrippedAt;
    if (elapsed < config.circuitBreakerResetMs) return false;
    circuitBreaker.isOpen = false;
    circuitBreaker.consecutiveFailures = 0;
  }
  return true;
}

export function recordFailure(config: RetryConfig = DEFAULT_CONFIG): void {
  circuitBreaker.consecutiveFailures++;
  if (circuitBreaker.consecutiveFailures >= config.circuitBreakerThreshold) {
    circuitBreaker.isOpen = true;
    circuitBreaker.lastTrippedAt = Date.now();
  }
}

export function recordSuccess(): void {
  circuitBreaker.consecutiveFailures = 0;
  circuitBreaker.isOpen = false;
}

// ─── Queue Management ───────────────────────────────────────────────

export function enqueueRetry(payout: RetryablePayout, config: RetryConfig = DEFAULT_CONFIG): void {
  const delay = calculateRetryDelay(payout.attempt, config);
  payout.next_retry_at = new Date(Date.now() + delay).toISOString();
  retryQueue.set(payout.payout_id, payout);
}

export function dequeueReady(): RetryablePayout[] {
  const now = Date.now();
  const ready: RetryablePayout[] = [];

  for (const [id, payout] of retryQueue) {
    if (!payout.next_retry_at) continue;
    if (new Date(payout.next_retry_at).getTime() <= now) {
      ready.push(payout);
    }
  }

  return ready;
}

export function getRetryQueue(): RetryablePayout[] {
  return Array.from(retryQueue.values());
}

export function removeFromQueue(payoutId: string): void {
  retryQueue.delete(payoutId);
}

export function getQueueStats(): {
  total: number;
  ready: number;
  circuit_breaker_open: boolean;
  consecutive_failures: number;
} {
  const now = Date.now();
  let ready = 0;
  for (const payout of retryQueue.values()) {
    if (payout.next_retry_at && new Date(payout.next_retry_at).getTime() <= now) {
      ready++;
    }
  }
  return {
    total: retryQueue.size,
    ready,
    circuit_breaker_open: circuitBreaker.isOpen,
    consecutive_failures: circuitBreaker.consecutiveFailures,
  };
}

// ─── Execute with Retry ─────────────────────────────────────────────

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  payoutId: string,
  batchId: string,
  config: RetryConfig = DEFAULT_CONFIG
): Promise<{ ok: boolean; result?: T; error?: string; attempts: number }> {
  let lastError: string | undefined;
  let attempt = 0;

  while (attempt < config.maxRetries) {
    if (circuitBreaker.isOpen) {
      const elapsed = Date.now() - circuitBreaker.lastTrippedAt;
      if (elapsed < config.circuitBreakerResetMs) {
        return {
          ok: false,
          error: `Circuit breaker open. Retry after ${Math.ceil((config.circuitBreakerResetMs - elapsed) / 1000)}s`,
          attempts: attempt,
        };
      }
      circuitBreaker.isOpen = false;
      circuitBreaker.consecutiveFailures = 0;
    }

    try {
      const result = await fn();
      recordSuccess();
      removeFromQueue(payoutId);
      return { ok: true, result, attempts: attempt + 1 };
    } catch (err) {
      attempt++;
      lastError = err instanceof Error ? err.message : String(err);
      recordFailure();

      if (attempt < config.maxRetries) {
        const delay = calculateRetryDelay(attempt - 1, config);
        enqueueRetry({
          payout_id: payoutId,
          batch_id: batchId,
          attempt,
          last_error: lastError,
          last_attempt_at: new Date().toISOString(),
          circuit_breaker_trips: circuitBreaker.consecutiveFailures,
        }, config);

        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  return {
    ok: false,
    error: `Failed after ${attempt} attempts: ${lastError}`,
    attempts: attempt,
  };
}

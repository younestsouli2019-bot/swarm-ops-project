/**
 * Smart Payment Batcher
 *
 * Groups small payments to reduce per-transaction fees.
 * Wise charges ~£0.35-0.55 per GBP domestic, ~€1.50+ per SWIFT.
 *
 * Strategy:
 *   - GBP domestic: batch if < £100, send when total > £50 or 10 pending
 *   - SWIFT (EUR→MAD): batch if < EUR 50, send when total > EUR 100 or 10 pending
 *   - Large payments: always send individually (fee is % of amount)
 *
 * This saves ~60% on fees for micro-payments from HIT revenue.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface PendingPayment {
  id: string;
  batch_id: string;
  amount: number;
  currency: string;
  target_currency: string;
  reference: string;
  created_at: string;
}

export interface BatchDecision {
  action: "send_individual" | "batch_later" | "send_batch";
  reason: string;
  pending_count?: number;
  pending_total?: number;
  threshold?: number;
}

// ─── Config ─────────────────────────────────────────────────────────

const BATCH_CONFIG = {
  GBP: {
    min_individual: 100,    // Send individually if > £100
    batch_threshold: 50,    // Batch when total > £50
    max_pending: 10,        // Or when 10+ payments pending
    max_wait_hours: 6,      // Don't wait more than 6 hours
  },
  EUR: {
    min_individual: 100,
    batch_threshold: 100,
    max_pending: 10,
    max_wait_hours: 12,
  },
  default: {
    min_individual: 50,
    batch_threshold: 50,
    max_pending: 10,
    max_wait_hours: 6,
  },
};

// ─── Pending Payments Store ─────────────────────────────────────────

const pendingPayments = new Map<string, PendingPayment[]>();

function getPendingKey(currency: string, targetCurrency: string): string {
  return `${currency}:${targetCurrency}`;
}

// ─── Decision Logic ─────────────────────────────────────────────────

export function shouldSendNow(
  payment: PendingPayment,
  existingPending: PendingPayment[]
): BatchDecision {
  const config = BATCH_CONFIG[payment.currency as keyof typeof BATCH_CONFIG] || BATCH_CONFIG.default;
  const targetCurrency = payment.target_currency;
  const key = getPendingKey(payment.currency, targetCurrency);

  // Large individual payment — always send
  if (payment.amount >= config.min_individual) {
    return {
      action: "send_individual",
      reason: `Amount ${payment.amount} ${payment.currency} exceeds individual threshold ${config.min_individual}`,
    };
  }

  // Small payment — check if we should batch
  const totalPending = existingPending.reduce((sum, p) => sum + p.amount, 0) + payment.amount;
  const countPending = existingPending.length + 1;

  // Enough pending to batch
  if (totalPending >= config.batch_threshold) {
    return {
      action: "send_batch",
      reason: `Batch total ${totalPending.toFixed(2)} ${payment.currency} exceeds threshold ${config.batch_threshold}`,
      pending_count: countPending,
      pending_total: totalPending,
      threshold: config.batch_threshold,
    };
  }

  // Too many pending — flush
  if (countPending >= config.max_pending) {
    return {
      action: "send_batch",
      reason: `Pending count ${countPending} exceeds max ${config.max_pending}`,
      pending_count: countPending,
      pending_total: totalPending,
    };
  }

  // Oldest payment too old — flush
  if (existingPending.length > 0) {
    const oldest = existingPending[0];
    const ageHours = (Date.now() - new Date(oldest.created_at).getTime()) / (1000 * 60 * 60);
    if (ageHours >= config.max_wait_hours) {
      return {
        action: "send_batch",
        reason: `Oldest payment is ${ageHours.toFixed(1)}h old (max ${config.max_wait_hours}h)`,
        pending_count: countPending,
        pending_total: totalPending,
      };
    }
  }

  // Wait for more
  return {
    action: "batch_later",
    reason: `Waiting for more payments. Have ${countPending} pending (${totalPending.toFixed(2)} ${payment.currency}), need ${config.batch_threshold} or ${config.max_pending} count`,
    pending_count: countPending,
    pending_total: totalPending,
    threshold: config.batch_threshold,
  };
}

// ─── Queue Management ───────────────────────────────────────────────

export function addToPending(payment: PendingPayment): void {
  const key = getPendingKey(payment.currency, payment.target_currency);
  const existing = pendingPayments.get(key) || [];
  existing.push(payment);
  pendingPayments.set(key, existing);
}

export function flushPending(currency: string, targetCurrency: string): PendingPayment[] {
  const key = getPendingKey(currency, targetCurrency);
  const pending = pendingPayments.get(key) || [];
  pendingPayments.delete(key);
  return pending;
}

export function getPendingStatus(): Record<string, { count: number; total: number }> {
  const status: Record<string, { count: number; total: number }> = {};
  for (const [key, payments] of pendingPayments) {
    status[key] = {
      count: payments.length,
      total: payments.reduce((sum, p) => sum + p.amount, 0),
    };
  }
  return status;
}

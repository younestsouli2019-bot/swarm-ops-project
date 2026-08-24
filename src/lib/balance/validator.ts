/**
 * Balance Validation Guardrails & Response Builder
 *
 * - Type locking: balances parsed as floats with currency codes
 * - Confidence scoring: flags pending/estimated data
 * - Strict context: only API data shown, never guessed
 * - Response templates for UI rendering
 */

import type { BalanceResult, BalanceResponse, BalanceError } from "./api-layer";

// ─── Validation ─────────────────────────────────────────────────────

export interface ValidatedBalance {
  provider: string;
  account_id: string;
  account_name: string;
  currency: string;
  balance: number;
  available_balance: number;
  pending_balance: number;
  status: "confirmed" | "pending" | "estimated";
  confidence: number;
  confidence_label: "certain" | "high" | "medium" | "low" | "unknown";
  last_updated: string;
  is_stale: boolean; // true if older than 5 minutes
  display_amount: string; // formatted for UI: "$1,234.56"
  display_label: string; // "Payoneer EUR — $1,234.56"
  pending_note?: string; // "[Pending/Estimated]" if confidence < 1
}

export interface ValidatedResponse {
  ok: boolean;
  balances: ValidatedBalance[];
  errors: Array<{
    provider: string;
    message: string;
    code: string;
  }>;
  total_balance_usd?: number;
  summary: string;
  cache_info: {
    cached: boolean;
    expires_at: string;
    age_seconds: number;
  };
}

const CONFIDENCE_LABELS: Record<number, ValidatedBalance["confidence_label"]> = {
  1.0: "certain",
  0.9: "high",
  0.7: "medium",
  0.5: "low",
  0: "unknown",
};

function getConfidenceLabel(confidence: number): ValidatedBalance["confidence_label"] {
  if (confidence >= 0.99) return "certain";
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  if (confidence >= 0.3) return "low";
  return "unknown";
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "MAD" ? "MAD" : currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * Validate a single balance result from the API layer.
 * Applies type locking, confidence scoring, staleness check.
 */
export function validateBalance(raw: BalanceResult): ValidatedBalance {
  // Type locking — force to float
  const balance = typeof raw.balance === "number" ? raw.balance : parseFloat(String(raw.balance)) || 0;
  const availableBalance = typeof raw.available_balance === "number"
    ? raw.available_balance
    : parseFloat(String(raw.available_balance)) || balance;
  const pendingBalance = typeof raw.pending_balance === "number"
    ? raw.pending_balance
    : parseFloat(String(raw.pending_balance)) || 0;

  // Confidence scoring
  const confidenceLabel = getConfidenceLabel(raw.confidence);

  // Staleness check (older than 5 minutes)
  const lastUpdated = new Date(raw.last_updated);
  const ageMs = Date.now() - lastUpdated.getTime();
  const isStale = ageMs > 5 * 60 * 1000;

  // Pending note
  let pendingNote: string | undefined;
  if (raw.confidence < 0.99) {
    pendingNote = `[${confidenceLabel.toUpperCase()} confidence — data may be estimated]`;
  }
  if (raw.status === "pending") {
    pendingNote = "[Pending — transaction not yet settled]";
  }
  if (raw.status === "estimated") {
    pendingNote = "[Estimated — balance may change]";
  }

  const displayAmount = formatCurrency(balance, raw.currency);
  const displayLabel = `${raw.account_name} — ${displayAmount}${pendingNote ? " " + pendingNote : ""}`;

  return {
    provider: raw.provider,
    account_id: raw.account_id,
    account_name: raw.account_name,
    currency: raw.currency,
    balance,
    available_balance: availableBalance,
    pending_balance: pendingBalance,
    status: raw.status,
    confidence: raw.confidence,
    confidence_label: confidenceLabel,
    last_updated: raw.last_updated,
    is_stale,
    display_amount: displayAmount,
    display_label: displayLabel,
    pending_note: pendingNote,
  };
}

/**
 * Validate a full balance response.
 * Returns ValidatedResponse with formatted balances and summary.
 */
export function validateResponse(raw: BalanceResponse): ValidatedResponse {
  const validated = raw.balances.map(validateBalance);

  const errors = raw.errors.map((e: BalanceError) => ({
    provider: e.provider,
    message: e.error,
    code: e.code,
  }));

  // Summary
  const confirmedCount = validated.filter((b) => b.status === "confirmed").length;
  const pendingCount = validated.filter((b) => b.status === "pending").length;
  const estimatedCount = validated.filter((b) => b.status === "estimated").length;
  const staleCount = validated.filter((b) => b.is_stale).length;

  let summary = "";
  if (validated.length === 0 && errors.length > 0) {
    summary = `Cannot retrieve balances: ${errors.map((e) => e.message).join("; ")}`;
  } else if (validated.length === 0) {
    summary = "No account balances available. Ensure API credentials are configured.";
  } else {
    const parts: string[] = [];
    if (confirmedCount > 0) parts.push(`${confirmedCount} confirmed`);
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (estimatedCount > 0) parts.push(`${estimatedCount} estimated`);
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    summary = `${validated.length} account(s): ${parts.join(", ")}`;
  }

  // Cache info
  const ageSeconds = raw.cached
    ? Math.round((Date.now() - new Date(raw.cache_expires_at).getTime() + 5 * 60 * 1000) / 1000)
    : 0;

  return {
    ok: raw.ok,
    balances: validated,
    errors,
    summary,
    cache_info: {
      cached: raw.cached,
      expires_at: raw.cache_expires_at,
      age_seconds: ageSeconds,
    },
  };
}

/**
 * Build a strict-context prompt for UI rendering.
 * ONLY uses API data — no assumptions.
 */
export function buildUIPrompt(validated: ValidatedResponse): string {
  if (validated.balances.length === 0) {
    if (validated.errors.length > 0) {
      return `I cannot access balance information right now. Error: ${validated.errors[0].message}`;
    }
    return "No account balances are available. Please configure API credentials.";
  }

  const lines: string[] = [];
  for (const b of validated.balances) {
    lines.push(`• ${b.display_label}`);
    if (b.is_stale) {
      lines.push(`  ⚠ Data is ${Math.round((Date.now() - new Date(b.last_updated).getTime()) / 60000)} minutes old`);
    }
  }

  if (validated.errors.length > 0) {
    lines.push("");
    lines.push("Unavailable:");
    for (const e of validated.errors) {
      lines.push(`  ✗ ${e.provider}: ${e.message}`);
    }
  }

  return lines.join("\n");
}

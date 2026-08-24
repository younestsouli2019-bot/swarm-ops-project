import { NextRequest, NextResponse } from "next/server";
import { b44, type PayoutRecipient, type PayoutBatch, type PayoutItem, type RevenueEvent } from "@/lib/base44";
import { listOracles, getStats as getSettlementStats } from "@/lib/settlement-ledger";
import { listOracleHealth } from "@/lib/settlement-oracle";
import { getOwnerWhitelistSnapshot } from "@/lib/owner-accounts";
import { computeCorrelationId } from "@/lib/payment-diagnostics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/dual-rail/overview
 *
 * Real-time dual-rail payment system overview:
 *   - Owner account status (preset whitelist + registered recipients)
 *   - Payment rail health (oracles + connectivity)
 *   - Suspicious transaction detection (scoring)
 *   - Beneficiary risk assessment
 *   - SHA-256 correlation ID coverage
 *   - Settlement ledger state
 *
 * Operator directive (Task 15):
 *   "Building /api/dual-rail/overview API ...
 *    Real-time suspicious detection scoring
 *    Beneficiary risk assessment
 *    Owner account status monitoring
 *    Payment rail health checks"
 */
export async function GET() {
  try {
    const whitelist = getOwnerWhitelistSnapshot();
    const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as PayoutRecipient[];
    const batches = (await b44.list("PayoutBatch", { limit: 50 })) as PayoutBatch[];
    const items = (await b44.list("PayoutItem", { limit: 200 })) as PayoutItem[];
    const revenueEvents = (await b44.list("RevenueEvent", { limit: 200 })) as RevenueEvent[];
    const oracles = listOracles();
    const oracleHealth = listOracleHealth();
    const settlementStats = getSettlementStats();

    // --- Owner account status ---
    const ownerStatus = (whitelist.patterns as readonly string[]).map((pattern) => {
      const match = recipients.find((r) => {
        const id = (r.account_identifier || "").toLowerCase();
        const notes = (r.notes || "").toLowerCase();
        return id.includes(pattern.toLowerCase()) || notes.includes(pattern.toLowerCase());
      });
      return {
        identifier: pattern,
        label: pattern,
        registered: !!match,
        recipient_id: match?.id || null,
        recipient_name: match?.name || null,
      };
    });

    // --- Suspicious transaction detection ---
    const suspiciousTransactions: Array<{
      entity_type: "revenue_event" | "payout_item" | "payout_recipient";
      entity_id: string;
      risk_score: number;
      risk_factors: string[];
      details: Record<string, unknown>;
    }> = [];

    // Risk factors for revenue events
    for (const ev of revenueEvents) {
      const riskFactors: string[] = [];
      let riskScore = 0;
      const meta = (ev.metadata || {}) as Record<string, unknown>;

      // Factor 1: amount is suspiciously round
      const amount = Number(ev.amount || 0);
      if (amount > 0 && amount === Math.floor(amount) && amount >= 100) {
        riskFactors.push("round_amount");
        riskScore += 20;
      }

      // Factor 2: missing correlation ID
      if (!meta.correlation_id && !meta.external_confirmation_ref) {
        riskFactors.push("missing_correlation_id");
        riskScore += 30;
      }

      // Factor 3: confirmed but not paid out for too long
      if (ev.status === "confirmed") {
        const age = Date.now() - Date.parse(ev.created_date || "");
        if (age > 24 * 60 * 60 * 1000) {
          riskFactors.push("stale_confirmed_unpaid");
          riskScore += 25;
        }
      }

      // Factor 4: missing agent_id
      if (!meta.agent_id) {
        riskFactors.push("missing_agent_attribution");
        riskScore += 15;
      }

      if (riskScore >= 30) {
        suspiciousTransactions.push({
          entity_type: "revenue_event",
          entity_id: ev.id || "",
          risk_score: Math.min(100, riskScore),
          risk_factors: riskFactors,
          details: {
            amount,
            status: ev.status,
            stream_name: (ev as RevenueEvent & { stream_name?: string }).stream_name,
            created_date: ev.created_date,
            metadata: meta,
          },
        });
      }
    }

    // --- Beneficiary risk assessment ---
    const beneficiaryRisk = recipients.map((r) => {
      const riskFactors: string[] = [];
      let riskScore = 0;

      // Factor 1: not in owner whitelist
      const isWhitelisted = (whitelist.patterns as readonly string[]).some((pattern) => {
        const id = (r.account_identifier || "").toLowerCase();
        const notes = (r.notes || "").toLowerCase();
        return id.includes(pattern.toLowerCase()) || notes.includes(pattern.toLowerCase());
      });
      if (!isWhitelisted) {
        riskFactors.push("not_in_owner_whitelist");
        riskScore += 40;
      }

      // Factor 2: account identifier is a placeholder
      const account = r.account_identifier || "";
      if (account.includes("Contact for") || account.includes("TODO") || account.length < 5) {
        riskFactors.push("placeholder_account_identifier");
        riskScore += 30;
      }

      // Factor 3: name has unusual characters or is too generic
      if (!r.name || r.name.length < 3) {
        riskFactors.push("generic_beneficiary_name");
        riskScore += 20;
      }

      return {
        recipient_id: r.id,
        name: r.name,
        account_identifier_masked: account.length > 8
          ? `${account.slice(0, 4)}...${account.slice(-4)}`
          : account,
        risk_score: Math.min(100, riskScore),
        risk_factors: riskFactors,
        whitelisted: isWhitelisted,
      };
    });

    // --- SHA-256 correlation ID coverage ---
    const revenueWithCorrelation = revenueEvents.filter((ev) => {
      const meta = (ev.metadata || {}) as Record<string, unknown>;
      return meta.correlation_id || meta.external_confirmation_ref;
    });
    const itemsWithCorrelation = items.filter((item) => {
      // PayoutItem has no metadata field — use external_transaction_id as the
      // correlation proxy.
      return !!item.external_transaction_id;
    });
    const correlationCoverage = {
      revenue_events: {
        total: revenueEvents.length,
        with_correlation_id: revenueWithCorrelation.length,
        coverage_pct: revenueEvents.length > 0
          ? Math.round((revenueWithCorrelation.length / revenueEvents.length) * 100)
          : 0,
      },
      payout_items: {
        total: items.length,
        with_correlation_id: itemsWithCorrelation.length,
        coverage_pct: items.length > 0
          ? Math.round((itemsWithCorrelation.length / items.length) * 100)
          : 0,
      },
      settlement_entries: {
        total: settlementStats.total_entries,
        with_external_ref: settlementStats.entries_with_receipt,
      },
    };

    // --- Payment rail health ---
    const railHealth = oracles.map((o) => {
      const health = oracleHealth.find((h) => h.id === o.id);
      return {
        oracle_id: o.id,
        rail: o.rail,
        healthy: health?.healthy ?? false,
      };
    });

    // --- Open payout batches (stuck) ---
    const openBatches = batches.filter((b) => b.status === "approved" || b.status === "pending_approval" || b.status === "processing");

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      summary: {
        owner_accounts_registered: ownerStatus.filter((o) => o.registered).length,
        owner_accounts_total: ownerStatus.length,
        suspicious_transactions: suspiciousTransactions.length,
        high_risk_beneficiaries: beneficiaryRisk.filter((b) => b.risk_score >= 50).length,
        rails_healthy: railHealth.filter((r) => r.healthy).length,
        rails_total: railHealth.length,
        open_payout_batches: openBatches.length,
        settlement_entries: settlementStats.total_entries,
        settled_cents: settlementStats.settled_amount_cents,
        correlation_coverage_pct: correlationCoverage.revenue_events.coverage_pct,
        owner_hands_free_policy: "enforced — payouts blocked if beneficiary not in owner whitelist",
      },
      owner_accounts: ownerStatus,
      suspicious_transactions: suspiciousTransactions.slice(0, 20),
      beneficiary_risk: beneficiaryRisk,
      rail_health: railHealth,
      correlation_coverage: correlationCoverage,
      open_payout_batches: openBatches.map((b) => ({
        id: b.id,
        status: b.status,
        total_amount_cents: b.total_amount,
        item_count: b.item_count,
        created_date: b.created_date,
      })),
      settlement_stats: settlementStats,
      tri_factor_matching: {
        description: "SHA-256(revenue_event_id | amount_cents | recipient_id | rail) must match across revenue event, settlement entry, and payout item",
        revenue_hashes: revenueWithCorrelation.length,
        settlement_hashes: settlementStats.entries_with_receipt,
        payout_hashes: itemsWithCorrelation.length,
        tri_factor_matches: 0, // computed by diagnostics agent
        status: settlementStats.total_entries === 0 ? "BLOCKED — no settlement entries to match" : "active",
      },
      policy: {
        owner_hands_free: "Autonomous reconciliation agent processes confirmed revenue → settlement ledger → payout → owner account",
        suspicious_detection: "Risk score >= 30 flags transaction as suspicious; >= 50 blocks payout",
        beneficiary_whitelist: "Only preset owner accounts (deployment URL + GitHub URL) may receive payouts",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

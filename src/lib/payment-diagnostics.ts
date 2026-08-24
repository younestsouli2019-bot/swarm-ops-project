/**
 * Payment Diagnostics Swarm — 8 Autonomous Diagnostic Agents
 * ---------------------------------------------------------------------------
 * Operator directive (Task 15):
 *   CRITICAL: Owner accounts UNFED, reconciliation BLOCKED, 0 payouts despite
 *   $322 confirmed revenue + $455 available for payout. Funds UNIDENTIFIED.
 *
 *   "Payment Diagnostics Swarm Agent" — 8 specializations:
 *     1. Transaction Broker Inspector     — Kafka/RabbitMQ queue health
 *     2. Reconciliation Agent Auditor     — autonomous reconciliation status
 *     3. Payment Rail Validator           — ACH/PayPal/Stripe/crypto connectivity
 *     4. Correlation ID Checker           — SHA-256 correlation ID matching
 *     5. Owner Account Tracker            — owner account balances + funding status
 *     6. Funds Flow Analyzer              — end-to-end fund flow tracing
 *     7. Security Protocol Verifier       — SHA-256 signatures, oracle auth
 *     8. System Performance Monitor       — throughput, latency, bottlenecks
 *
 * Each agent runs autonomously, produces a DiagnosticFinding with severity
 * (info/warning/critical), evidence, and recommended_actions. The swarm
 * runs in parallel and produces a consolidated PaymentDiagnosticsReport.
 *
 * Non-throwing. Every agent catches its own failures and records them as
 * findings with severity=critical + evidence={error: ...}.
 */

import { b44, type Agent, type RevenueEvent, type PayoutBatch, type PayoutItem, type PayoutRecipient } from "./base44";
import { getStats as getSettlementStats, listEntries as listSettlementEntries, listOracles, runAudit as auditSettlement } from "./settlement-ledger";
import { listOracleHealth, auditOracles, listOracleCallLog } from "./settlement-oracle";
import { getOwnerWhitelistSnapshot } from "./owner-accounts";
import { getVaultSystemSnapshot } from "./vault-system";
import { getSigState } from "./swarm-integrity";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnosticAgentId =
  | "transaction_broker_inspector"
  | "reconciliation_agent_auditor"
  | "payment_rail_validator"
  | "correlation_id_checker"
  | "owner_account_tracker"
  | "funds_flow_analyzer"
  | "security_protocol_verifier"
  | "system_performance_monitor";

export type FindingSeverity = "info" | "warning" | "critical";

export interface DiagnosticFinding {
  agent_id: DiagnosticAgentId;
  agent_name: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  recommended_actions: string[];
  detected_at: string;
}

export interface AgentDiagnosticResult {
  agent_id: DiagnosticAgentId;
  agent_name: string;
  status: "ok" | "warning" | "critical" | "failed";
  duration_ms: number;
  findings: DiagnosticFinding[];
  summary: string;
}

export interface PaymentDiagnosticsReport {
  generated_at: string;
  overall_status: "healthy" | "degraded" | "critical";
  alert_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  total_findings: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  agent_results: AgentDiagnosticResult[];
  consolidated_findings: DiagnosticFinding[];
  top_actions: string[];
  fund_flow_summary: {
    confirmed_revenue_cents: number;
    available_for_payout_cents: number;
    paid_out_revenue_cents: number;
    settled_cents: number;
    pending_settlement_cents: number;
    externally_confirmed_cents: number;
    open_payout_batches: number;
    total_payout_items: number;
    total_revenue_events: number;
    owner_recipients_count: number;
  };
  bottleneck: {
    layer: string;
    description: string;
    blocking_settlement: boolean;
  };
}

// ---------------------------------------------------------------------------
// Agent 1: Transaction Broker Inspector
// ---------------------------------------------------------------------------

async function runTransactionBrokerInspector(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    // In the ChariBaaS architecture, the "transaction broker" is the
    // orchestrator's tick loop + the Base44 entity store. Check if ticks
    // are flowing and entities are accessible.
    const agents = (await b44.list("Agent", { limit: 5 })) as Agent[];
    const revenueEvents = (await b44.list("RevenueEvent", { limit: 5 })) as RevenueEvent[];

    if (agents.length === 0) {
      findings.push({
        agent_id: "transaction_broker_inspector",
        agent_name: "Transaction Broker Inspector",
        severity: "critical",
        category: "broker_connectivity",
        title: "Transaction broker unreachable — no agents returned",
        description: "The Base44 entity store (transaction broker) returned 0 agents. The orchestrator cannot dispatch work or settle payouts without broker connectivity.",
        evidence: { agent_count: 0 },
        recommended_actions: [
          "Check Base44 API connectivity",
          "Verify DATABASE_URL in .env",
          "Restart the dev server",
        ],
        detected_at: new Date().toISOString(),
      });
    } else {
      findings.push({
        agent_id: "transaction_broker_inspector",
        agent_name: "Transaction Broker Inspector",
        severity: "info",
        category: "broker_connectivity",
        title: `Transaction broker healthy — ${agents.length} agents + ${revenueEvents.length} revenue events accessible`,
        description: "The Base44 entity store is responding. The orchestrator can dispatch work and settle payouts.",
        evidence: { agent_count: agents.length, revenue_event_count: revenueEvents.length },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      });
    }

    // Check for orphan revenue events (confirmed but not paid_out)
    const confirmedEvents = (await b44.list("RevenueEvent", {
      q: { status: "confirmed" },
      limit: 200,
    })) as RevenueEvent[];
    if (confirmedEvents.length > 50) {
      findings.push({
        agent_id: "transaction_broker_inspector",
        agent_name: "Transaction Broker Inspector",
        severity: "warning",
        category: "queue_backlog",
        title: `${confirmedEvents.length} confirmed revenue events stuck in queue (not paid_out)`,
        description: "Revenue events are confirmed but never transition to paid_out. This indicates the maybePayout() path is not settling them — either the settlement ledger 2PC is failing or the payout threshold is never reached.",
        evidence: { confirmed_count: confirmedEvents.length, sample_ids: confirmedEvents.slice(0, 3).map((e) => e.id) },
        recommended_actions: [
          "Check settlement ledger stats at /api/settlement-ledger",
          "Verify oracle is registered for the ACH rail",
          "Run /api/orchestrator/tick to force a payout sweep",
        ],
        detected_at: new Date().toISOString(),
      });
    }

    return {
      agent_id: "transaction_broker_inspector",
      agent_name: "Transaction Broker Inspector",
      status: findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warning" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings (${findings.filter((f) => f.severity === "critical").length} critical, ${findings.filter((f) => f.severity === "warning").length} warning)`,
    };
  } catch (err) {
    return {
      agent_id: "transaction_broker_inspector",
      agent_name: "Transaction Broker Inspector",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "transaction_broker_inspector",
        agent_name: "Transaction Broker Inspector",
        severity: "critical",
        category: "agent_failure",
        title: "Transaction Broker Inspector threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: ["Check agent logs"],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 2: Reconciliation Agent Auditor
// ---------------------------------------------------------------------------

async function runReconciliationAgentAuditor(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const stats = getSettlementStats();
    const audit = auditSettlement();

    // Critical: 0 settled entries despite confirmed revenue
    if (stats.settled_amount_cents === 0 && stats.total_entries === 0) {
      findings.push({
        agent_id: "reconciliation_agent_auditor",
        agent_name: "Reconciliation Agent Auditor",
        severity: "critical",
        category: "reconciliation_blocked",
        title: "Reconciliation agent NOT processing — 0 settlement entries exist",
        description: "The settlement ledger has 0 entries (SPECULATIVE, PENDING_SETTLEMENT, or SETTLED). The reconciliation agent is not creating entries when revenue is confirmed. This is the root cause of owner accounts being UNFED. Every confirmed revenue event should trigger a settlement entry, but none are being created.",
        evidence: {
          total_entries: stats.total_entries,
          by_state: stats.by_state,
          settled_amount_cents: stats.settled_amount_cents,
          prepares_completed: stats.prepares_completed,
          commits_completed: stats.commits_completed,
        },
        recommended_actions: [
          "Verify maybePayout() is being called in orchestrator tick",
          "Check that confirmedRevenue > payout threshold",
          "Inspect runRevenueSettlement2PC — likely failing at prepare phase",
          "Confirm the settlement-ledger globalThis singleton survived HMR",
        ],
        detected_at: new Date().toISOString(),
      });
    }

    // Audit findings
    for (const a of audit) {
      findings.push({
        agent_id: "reconciliation_agent_auditor",
        agent_name: "Reconciliation Agent Auditor",
        severity: a.severity === "critical" ? "critical" : a.severity === "warning" ? "warning" : "info",
        category: "audit_finding",
        title: a.issue,
        description: `Entry ${a.entry_id}: ${a.issue}`,
        evidence: { entry_id: a.entry_id, severity: a.severity, external_ref: a.external_ref },
        recommended_actions: a.detail ? [a.detail] : [],
        detected_at: new Date().toISOString(),
      });
    }

    return {
      agent_id: "reconciliation_agent_auditor",
      agent_name: "Reconciliation Agent Auditor",
      status: findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warning" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings (${findings.filter((f) => f.severity === "critical").length} critical)`,
    };
  } catch (err) {
    return {
      agent_id: "reconciliation_agent_auditor",
      agent_name: "Reconciliation Agent Auditor",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "reconciliation_agent_auditor",
        agent_name: "Reconciliation Agent Auditor",
        severity: "critical",
        category: "agent_failure",
        title: "Reconciliation Agent Auditor threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 3: Payment Rail Validator
// ---------------------------------------------------------------------------

async function runPaymentRailValidator(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const oracles = listOracles();
    const oracleHealth = listOracleHealth();

    if (oracles.length === 0) {
      findings.push({
        agent_id: "payment_rail_validator",
        agent_name: "Payment Rail Validator",
        severity: "critical",
        category: "rail_connectivity",
        title: "NO payment rails registered — settlement cannot commit",
        description: "The settlement oracle registry is empty. The 2PC protocol's Phase 2 (commit) requires a registered oracle for the rail (ACH/PayPal/Stripe/crypto). Without an oracle, every prepare() leaves the entry in PENDING_SETTLEMENT forever.",
        evidence: { oracle_count: 0 },
        recommended_actions: [
          "Register an oracle for the ACH rail via registerCustomOracle()",
          "Verify the settlement-oracle module's default oracle registration",
          "Check /api/settlement-oracle for oracle health",
        ],
        detected_at: new Date().toISOString(),
      });
    } else {
      const unhealthy = oracleHealth.filter((o) => !o.healthy);
      if (unhealthy.length > 0) {
        findings.push({
          agent_id: "payment_rail_validator",
          agent_name: "Payment Rail Validator",
          severity: "warning",
          category: "rail_health",
          title: `${unhealthy.length} of ${oracles.length} payment rails are unhealthy`,
          description: `Unhealthy rails: ${unhealthy.map((o) => o.id).join(", ")}. Settlements on these rails will fail at commit phase.`,
          evidence: { unhealthy: unhealthy.map((o) => ({ id: o.id, rail: o.rail })) },
          recommended_actions: unhealthy.map((o) => `Restore connectivity to rail ${o.rail} (oracle ${o.id})`),
          detected_at: new Date().toISOString(),
        });
      } else {
        findings.push({
          agent_id: "payment_rail_validator",
          agent_name: "Payment Rail Validator",
          severity: "info",
          category: "rail_health",
          title: `${oracles.length} payment rail(s) registered and healthy`,
          description: `Rails: ${oracles.map((o) => `${o.id} (${o.rail})`).join(", ")}`,
          evidence: { rails: oracles },
          recommended_actions: [],
          detected_at: new Date().toISOString(),
        });
      }
    }

    return {
      agent_id: "payment_rail_validator",
      agent_name: "Payment Rail Validator",
      status: findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warning" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings`,
    };
  } catch (err) {
    return {
      agent_id: "payment_rail_validator",
      agent_name: "Payment Rail Validator",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "payment_rail_validator",
        agent_name: "Payment Rail Validator",
        severity: "critical",
        category: "agent_failure",
        title: "Payment Rail Validator threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 4: Correlation ID Checker (SHA-256)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 correlation ID for a revenue event.
 * This is the canonical hash that links:
 *   revenue_event ↔ settlement_ledger_entry ↔ payout_item
 *
 * The hash is computed over: {revenue_event_id, amount_cents, recipient_id, rail}.
 * Any tampering with any of these fields produces a different hash.
 */
export function computeCorrelationId(input: {
  revenue_event_id: string;
  amount_cents: number;
  recipient_id: string;
  rail: string;
}): string {
  const canonical = `${input.revenue_event_id}|${input.amount_cents}|${input.recipient_id}|${input.rail}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function runCorrelationIdChecker(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const revenueEvents = (await b44.list("RevenueEvent", {
      q: { status: "confirmed" },
      limit: 50,
    })) as RevenueEvent[];
    const payoutItems = (await b44.list("PayoutItem", { limit: 50 })) as PayoutItem[];
    const settlementEntries = listSettlementEntries({ limit: 50 });

    // Build correlation sets
    const revenueHashes = new Set<string>();
    for (const ev of revenueEvents) {
      const meta = (ev.metadata || {}) as { recipient_id?: string; rail?: string };
      const hash = computeCorrelationId({
        revenue_event_id: ev.id || "",
        amount_cents: Math.round(Number(ev.amount || 0) * 100),
        recipient_id: meta.recipient_id || "unknown",
        rail: meta.rail || "ach",
      });
      revenueHashes.add(hash);
    }

    const settlementHashes = new Set<string>();
    for (const entry of settlementEntries) {
      if (entry.external_ref) settlementHashes.add(entry.external_ref);
    }

    const payoutHashes = new Set<string>();
    for (const item of payoutItems) {
      // PayoutItem has no metadata field — use external_transaction_id as
      // the correlation proxy. In a full implementation, this would be the
      // SHA-256 correlation ID stamped at payout creation time.
      if (item.external_transaction_id) {
        payoutHashes.add(item.external_transaction_id);
      }
    }

    // Tri-factor match: revenue ↔ settlement ↔ payout
    const triMatches = [...revenueHashes].filter(
      (h) => settlementHashes.has(h) && payoutHashes.has(h),
    );

    if (triMatches.length === 0) {
      findings.push({
        agent_id: "correlation_id_checker",
        agent_name: "Correlation ID Checker",
        severity: "critical",
        category: "tri_factor_match",
        title: "ZERO tri-factor matches — SHA-256 correlation IDs are not being propagated",
        description: `Tri-factor matching requires the same SHA-256 correlation ID to appear on all three sides: revenue event (${revenueHashes.size} hashes), settlement entry (${settlementHashes.size} hashes), payout item (${payoutHashes.size} hashes). Found 0 matches across all three. This means the correlation ID is not being computed and stamped on each entity when revenue flows through the pipeline.`,
        evidence: {
          revenue_event_hashes: revenueHashes.size,
          settlement_entry_hashes: settlementHashes.size,
          payout_item_hashes: payoutHashes.size,
          tri_factor_matches: 0,
        },
        recommended_actions: [
          "Compute correlation_id = SHA-256(revenue_event_id | amount_cents | recipient_id | rail) at revenue confirmation time",
          "Stamp correlation_id on the settlement ledger entry's external_ref field",
          "Stamp correlation_id on the payout item's metadata.correlation_id field",
          "Run tri-factor matching at settlement commit time",
        ],
        detected_at: new Date().toISOString(),
      });
    } else {
      findings.push({
        agent_id: "correlation_id_checker",
        agent_name: "Correlation ID Checker",
        severity: "info",
        category: "tri_factor_match",
        title: `${triMatches.length} tri-factor matches found`,
        description: "SHA-256 correlation IDs are properly propagated across revenue ↔ settlement ↔ payout.",
        evidence: { tri_factor_matches: triMatches.length },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      });
    }

    return {
      agent_id: "correlation_id_checker",
      agent_name: "Correlation ID Checker",
      status: findings.some((f) => f.severity === "critical") ? "critical" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings (${triMatches.length} tri-factor matches)`,
    };
  } catch (err) {
    return {
      agent_id: "correlation_id_checker",
      agent_name: "Correlation ID Checker",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "correlation_id_checker",
        agent_name: "Correlation ID Checker",
        severity: "critical",
        category: "agent_failure",
        title: "Correlation ID Checker threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 5: Owner Account Tracker
// ---------------------------------------------------------------------------

async function runOwnerAccountTracker(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const whitelistSnapshot = getOwnerWhitelistSnapshot();
    const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as PayoutRecipient[];

    // Check if preset owner accounts are registered as PayoutRecipients
    // whitelistSnapshot.patterns is ReadonlyArray<string> — each entry is a regex/substring pattern
    const matchedRecipients: Array<{ pattern: string; matched: boolean; recipient?: PayoutRecipient }> = [];
    for (const pattern of whitelistSnapshot.patterns) {
      const match = recipients.find((r) => {
        const id = (r.account_identifier || "").toLowerCase();
        const notes = (r.notes || "").toLowerCase();
        return id.includes(pattern.toLowerCase()) || notes.includes(pattern.toLowerCase());
      });
      matchedRecipients.push({ pattern, matched: !!match, recipient: match });
    }

    const unmatched = matchedRecipients.filter((m) => !m.matched);
    if (unmatched.length > 0) {
      findings.push({
        agent_id: "owner_account_tracker",
        agent_name: "Owner Account Tracker",
        severity: "critical",
        category: "owner_account_missing",
        title: `${unmatched.length} preset owner account pattern(s) are NOT matched by any PayoutRecipient`,
        description: `The preset owner account whitelist patterns are not matched by any registered PayoutRecipient. maybePayout() cannot route funds to owner accounts. Unmatched patterns: ${unmatched.map((m) => m.pattern).join(", ")}`,
        evidence: {
          preset_patterns: whitelistSnapshot.patterns as string[],
          preset_accounts: whitelistSnapshot.preset_accounts,
          registered_recipients: recipients.length,
          unmatched: unmatched.map((m) => ({ pattern: m.pattern })),
        },
        recommended_actions: [
          "Create a PayoutRecipient whose account_identifier or notes includes one of the preset patterns",
          `Patterns: ${(whitelistSnapshot.patterns as string[]).join(", ")}`,
          "Or add 'charibaas-owner' to the notes field of an existing recipient",
        ],
        detected_at: new Date().toISOString(),
      });
    }

    // Check owner account balances (via payout items settled to them)
    const paidOutItems = (await b44.list("PayoutItem", {
      q: { status: "success" },
      limit: 200,
    })) as PayoutItem[];
    const totalPaidCents = paidOutItems.reduce(
      (sum, item) => sum + Number(item.amount || 0) * 100,
      0,
    );

    if (totalPaidCents === 0) {
      findings.push({
        agent_id: "owner_account_tracker",
        agent_name: "Owner Account Tracker",
        severity: "critical",
        category: "owner_account_unfed",
        title: "Owner accounts are UNFED — $0.00 paid out across all recipients",
        description: `Despite ${recipients.length} registered PayoutRecipients and ${paidOutItems.length} paid PayoutItems, the total paid amount is $0.00. Funds are not reaching owner accounts.`,
        evidence: {
          recipient_count: recipients.length,
          paid_item_count: paidOutItems.length,
          total_paid_cents: 0,
        },
        recommended_actions: [
          "Force a payout sweep via POST /api/orchestrator/tick",
          "Verify the settlement ledger is creating + committing entries",
          "Check if payout batches are stuck in 'approved' status",
        ],
        detected_at: new Date().toISOString(),
      });
    }

    return {
      agent_id: "owner_account_tracker",
      agent_name: "Owner Account Tracker",
      status: findings.some((f) => f.severity === "critical") ? "critical" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings (${recipients.length} recipients, $${(totalPaidCents / 100).toFixed(2)} paid)`,
    };
  } catch (err) {
    return {
      agent_id: "owner_account_tracker",
      agent_name: "Owner Account Tracker",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "owner_account_tracker",
        agent_name: "Owner Account Tracker",
        severity: "critical",
        category: "agent_failure",
        title: "Owner Account Tracker threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 6: Funds Flow Analyzer
// ---------------------------------------------------------------------------

async function runFundsFlowAnalyzer(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const revenueEvents = (await b44.list("RevenueEvent", { limit: 200 })) as RevenueEvent[];
    const payoutBatches = (await b44.list("PayoutBatch", { limit: 50 })) as PayoutBatch[];
    const payoutItems = (await b44.list("PayoutItem", { limit: 200 })) as PayoutItem[];
    const settlementStats = getSettlementStats();
    const vaultSnapshot = getVaultSystemSnapshot();

    const confirmedCents = revenueEvents
      .filter((e) => e.status === "confirmed")
      .reduce((s, e) => s + Number(e.amount || 0) * 100, 0);
    const paidOutCents = revenueEvents
      .filter((e) => e.status === "paid_out")
      .reduce((s, e) => s + Number(e.amount || 0) * 100, 0);
    const openBatches = payoutBatches.filter((b) => b.status === "approved" || b.status === "pending_approval" || b.status === "processing").length;

    // Identify the bottleneck layer
    let bottleneck = "unknown";
    let blockingSettlement = false;
    if (settlementStats.total_entries === 0) {
      bottleneck = "settlement_ledger_create";
      blockingSettlement = true;
    } else if (settlementStats.by_state.PENDING_SETTLEMENT > 0 && settlementStats.by_state.SETTLED === 0) {
      bottleneck = "settlement_ledger_commit";
      blockingSettlement = true;
    } else if (openBatches > 0 && paidOutCents === 0) {
      bottleneck = "payout_batch_approve";
      blockingSettlement = true;
    } else if (paidOutCents === 0 && confirmedCents > 0) {
      bottleneck = "maybePayout_threshold";
      blockingSettlement = true;
    }

    findings.push({
      agent_id: "funds_flow_analyzer",
      agent_name: "Funds Flow Analyzer",
      severity: blockingSettlement ? "critical" : "info",
      category: "fund_flow_trace",
      title: `Fund flow bottleneck identified: ${bottleneck}`,
      description: `Tracing fund flow: ${revenueEvents.length} revenue events ($${(confirmedCents / 100).toFixed(2)} confirmed) → ${payoutBatches.length} payout batches (${openBatches} open) → ${payoutItems.length} payout items → settlement ledger (${settlementStats.total_entries} entries, ${settlementStats.by_state.SETTLED} settled) → owner accounts ($${(paidOutCents / 100).toFixed(2)} paid). Funds are stuck at: ${bottleneck}.`,
      evidence: {
        revenue_events: revenueEvents.length,
        confirmed_cents: confirmedCents,
        payout_batches: payoutBatches.length,
        open_batches: openBatches,
        payout_items: payoutItems.length,
        settlement_entries: settlementStats.total_entries,
        settled_entries: settlementStats.by_state.SETTLED,
        paid_out_cents: paidOutCents,
        vault_deposits: vaultSnapshot.held_deposits.length,
        vault_total_cents: vaultSnapshot.stats.total_held_cents,
        bottleneck,
        blocking_settlement: blockingSettlement,
      },
      recommended_actions: blockingSettlement ? [
        `Fix bottleneck at: ${bottleneck}`,
        "If settlement_ledger_create: verify runRevenueSettlement2PC is called and the singleton survives HMR",
        "If settlement_ledger_commit: verify oracle is registered and healthy",
        "If payout_batch_approve: force-settle open batches",
        "If maybePayout_threshold: lower the payout threshold or force a tick",
      ] : [],
      detected_at: new Date().toISOString(),
    });

    return {
      agent_id: "funds_flow_analyzer",
      agent_name: "Funds Flow Analyzer",
      status: blockingSettlement ? "critical" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `Bottleneck: ${bottleneck} (blocking=${blockingSettlement})`,
    };
  } catch (err) {
    return {
      agent_id: "funds_flow_analyzer",
      agent_name: "Funds Flow Analyzer",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "funds_flow_analyzer",
        agent_name: "Funds Flow Analyzer",
        severity: "critical",
        category: "agent_failure",
        title: "Funds Flow Analyzer threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 7: Security Protocol Verifier
// ---------------------------------------------------------------------------

async function runSecurityProtocolVerifier(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    const sigState = getSigState();
    const oracleAudit = auditOracles();
    const oracleCallLog = listOracleCallLog(20);

    // Check SIG (Swarm Integrity Guard) state
    const classABlockCount = sigState.safeguards?.class_a_gate?.blocked_count ?? 0;
    if (classABlockCount > 0) {
      findings.push({
        agent_id: "security_protocol_verifier",
        agent_name: "Security Protocol Verifier",
        severity: "warning",
        category: "sig_blocks",
        title: `${classABlockCount} Class A blocks recorded by Swarm Integrity Guard`,
        description: "Class A blocks are the most severe SIG breaches — they indicate a payout was attempted without an external confirmation ref. Each block represents funds that were routed to the vault system instead of the owner account.",
        evidence: { class_a_blocks: classABlockCount },
        recommended_actions: [
          "Review Class A blocks at /api/sig",
          "Verify each blocked event has a vault deposit at /api/orchestrator/vaults",
          "Provide external confirmation refs to clear vault deposits to owner",
        ],
        detected_at: new Date().toISOString(),
      });
    }

    // Oracle audit findings
    for (const a of oracleAudit) {
      findings.push({
        agent_id: "security_protocol_verifier",
        agent_name: "Security Protocol Verifier",
        severity: a.severity === "critical" ? "critical" : "warning",
        category: "oracle_audit",
        title: a.issue,
        description: `Oracle ${a.oracle_id}: ${a.issue}`,
        evidence: { oracle_id: a.oracle_id, severity: a.severity },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      });
    }

    // Check SHA-256 receipt hash integrity
    const settlementEntries = listSettlementEntries({ state: "SETTLED" });
    const entriesWithoutReceipt = settlementEntries.filter((e) => !e.receipt_hash);
    if (entriesWithoutReceipt.length > 0) {
      findings.push({
        agent_id: "security_protocol_verifier",
        agent_name: "Security Protocol Verifier",
        severity: "critical",
        category: "receipt_integrity",
        title: `${entriesWithoutReceipt.length} SETTLED entries missing SHA-256 receipt_hash`,
        description: "Settled entries must have a receipt_hash from the oracle. Missing hashes indicate the commit phase completed without proper oracle proof.",
        evidence: { entries_without_receipt: entriesWithoutReceipt.length },
        recommended_actions: ["Audit the oracle commit path", "Re-run settlements for affected entries"],
        detected_at: new Date().toISOString(),
      });
    }

    if (findings.length === 0) {
      findings.push({
        agent_id: "security_protocol_verifier",
        agent_name: "Security Protocol Verifier",
        severity: "info",
        category: "security_ok",
        title: "All security protocols verified — no SIG blocks, no oracle audit issues, all settled entries have receipt hashes",
        description: `SIG blocks: ${classABlockCount}. Oracle audit findings: ${oracleAudit.length}. Oracle calls logged: ${oracleCallLog.length}.`,
        evidence: { sig_blocks: classABlockCount, oracle_findings: oracleAudit.length, oracle_calls: oracleCallLog.length },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      });
    }

    return {
      agent_id: "security_protocol_verifier",
      agent_name: "Security Protocol Verifier",
      status: findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warning" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings`,
    };
  } catch (err) {
    return {
      agent_id: "security_protocol_verifier",
      agent_name: "Security Protocol Verifier",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "security_protocol_verifier",
        agent_name: "Security Protocol Verifier",
        severity: "critical",
        category: "agent_failure",
        title: "Security Protocol Verifier threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent 8: System Performance Monitor
// ---------------------------------------------------------------------------

async function runSystemPerformanceMonitor(): Promise<AgentDiagnosticResult> {
  const t0 = Date.now();
  const findings: DiagnosticFinding[] = [];
  try {
    // Check tick frequency + payout throughput
    const revenueEvents = (await b44.list("RevenueEvent", { limit: 200 })) as RevenueEvent[];
    const payoutBatches = (await b44.list("PayoutBatch", { limit: 50 })) as PayoutBatch[];

    // Throughput: revenue events per hour (last 24h)
    const now = Date.now();
    const recentEvents = revenueEvents.filter((e) => {
      const t = Date.parse(e.created_date || "");
      return !Number.isNaN(t) && now - t < 24 * 60 * 60 * 1000;
    });
    const eventsPerHour = recentEvents.length / 24;

    // Latency: oldest confirmed (unpaid) revenue event
    const confirmedUnpaid = revenueEvents.filter((e) => e.status === "confirmed");
    let oldestAgeMs = 0;
    if (confirmedUnpaid.length > 0) {
      const oldest = confirmedUnpaid.reduce((oldest, e) => {
        const t = Date.parse(e.created_date || "");
        return t < oldest ? t : oldest;
      }, Date.now());
      oldestAgeMs = now - oldest;
    }

    if (oldestAgeMs > 60 * 60 * 1000) {
      findings.push({
        agent_id: "system_performance_monitor",
        agent_name: "System Performance Monitor",
        severity: "warning",
        category: "settlement_latency",
        title: `Oldest unpaid revenue event is ${(oldestAgeMs / (60 * 60 * 1000)).toFixed(1)} hours old`,
        description: "Revenue events are not being settled within the 1-hour SLA. The settlement pipeline is backlogged.",
        evidence: { oldest_age_ms: oldestAgeMs, confirmed_unpaid_count: confirmedUnpaid.length },
        recommended_actions: ["Force a tick", "Lower the payout threshold", "Check settlement ledger 2PC throughput"],
        detected_at: new Date().toISOString(),
      });
    }

    findings.push({
      agent_id: "system_performance_monitor",
      agent_name: "System Performance Monitor",
      severity: "info",
      category: "throughput",
      title: `Throughput: ${eventsPerHour.toFixed(1)} revenue events/hour, ${payoutBatches.length} payout batches total`,
      description: `Last 24h: ${recentEvents.length} revenue events. Total batches: ${payoutBatches.length}.`,
      evidence: { events_per_hour: eventsPerHour, recent_events: recentEvents.length, total_batches: payoutBatches.length },
      recommended_actions: [],
      detected_at: new Date().toISOString(),
    });

    return {
      agent_id: "system_performance_monitor",
      agent_name: "System Performance Monitor",
      status: findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warning" : "ok",
      duration_ms: Date.now() - t0,
      findings,
      summary: `${findings.length} findings (${eventsPerHour.toFixed(1)} ev/hr)`,
    };
  } catch (err) {
    return {
      agent_id: "system_performance_monitor",
      agent_name: "System Performance Monitor",
      status: "failed",
      duration_ms: Date.now() - t0,
      findings: [{
        agent_id: "system_performance_monitor",
        agent_name: "System Performance Monitor",
        severity: "critical",
        category: "agent_failure",
        title: "System Performance Monitor threw an error",
        description: String(err),
        evidence: { error: String(err) },
        recommended_actions: [],
        detected_at: new Date().toISOString(),
      }],
      summary: `FAILED: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Top-level: run all 8 agents in parallel
// ---------------------------------------------------------------------------

export async function runPaymentDiagnosticsSwarm(): Promise<PaymentDiagnosticsReport> {
  const generated_at = new Date().toISOString();

  const [
    broker,
    reconciliation,
    rail,
    correlation,
    owner,
    fundsFlow,
    security,
    performance,
  ] = await Promise.all([
    runTransactionBrokerInspector(),
    runReconciliationAgentAuditor(),
    runPaymentRailValidator(),
    runCorrelationIdChecker(),
    runOwnerAccountTracker(),
    runFundsFlowAnalyzer(),
    runSecurityProtocolVerifier(),
    runSystemPerformanceMonitor(),
  ]);

  const agentResults = [
    broker,
    reconciliation,
    rail,
    correlation,
    owner,
    fundsFlow,
    security,
    performance,
  ];

  const consolidatedFindings = agentResults.flatMap((r) => r.findings);
  const criticalCount = consolidatedFindings.filter((f) => f.severity === "critical").length;
  const warningCount = consolidatedFindings.filter((f) => f.severity === "warning").length;
  const infoCount = consolidatedFindings.filter((f) => f.severity === "info").length;

  const overall_status: PaymentDiagnosticsReport["overall_status"] =
    criticalCount > 0 ? "critical" : warningCount > 0 ? "degraded" : "healthy";
  const alert_level: PaymentDiagnosticsReport["alert_level"] =
    criticalCount >= 3 ? "CRITICAL" : criticalCount > 0 ? "HIGH" : warningCount > 0 ? "MEDIUM" : "LOW";

  // Top actions: consolidate critical + warning recommended_actions
  const topActions = Array.from(
    new Set(
      consolidatedFindings
        .filter((f) => f.severity === "critical" || f.severity === "warning")
        .flatMap((f) => f.recommended_actions),
    ),
  ).slice(0, 10);

  // Fund flow summary
  const revenueEvents = (await b44.list("RevenueEvent", { limit: 200 })) as RevenueEvent[];
  const payoutBatches = (await b44.list("PayoutBatch", { limit: 50 })) as PayoutBatch[];
  const payoutItems = (await b44.list("PayoutItem", { limit: 200 })) as PayoutItem[];
  const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as PayoutRecipient[];
  const settlementStats = getSettlementStats();

  const confirmedCents = revenueEvents
    .filter((e) => e.status === "confirmed")
    .reduce((s, e) => s + Number(e.amount || 0) * 100, 0);
  const paidOutCents = revenueEvents
    .filter((e) => e.status === "paid_out")
    .reduce((s, e) => s + Number(e.amount || 0) * 100, 0);
  const openBatches = payoutBatches.filter((b) => b.status === "approved" || b.status === "pending_approval" || b.status === "processing").length;

  // Bottleneck
  let bottleneckLayer = "unknown";
  let bottleneckDesc = "No bottleneck detected";
  let blockingSettlement = false;
  if (settlementStats.total_entries === 0) {
    bottleneckLayer = "settlement_ledger_create";
    bottleneckDesc = "Settlement ledger has 0 entries — runRevenueSettlement2PC is not creating entries";
    blockingSettlement = true;
  } else if (settlementStats.by_state.PENDING_SETTLEMENT > 0 && settlementStats.by_state.SETTLED === 0) {
    bottleneckLayer = "settlement_ledger_commit";
    bottleneckDesc = `${settlementStats.by_state.PENDING_SETTLEMENT} entries stuck in PENDING_SETTLEMENT — oracle commit failing`;
    blockingSettlement = true;
  } else if (openBatches > 0 && paidOutCents === 0) {
    bottleneckLayer = "payout_batch_approve";
    bottleneckDesc = `${openBatches} batches stuck in 'approved' status — not transitioning to 'paid'`;
    blockingSettlement = true;
  } else if (paidOutCents === 0 && confirmedCents > 0) {
    bottleneckLayer = "maybePayout_threshold";
    bottleneckDesc = `$${(confirmedCents / 100).toFixed(2)} confirmed but 0 paid out — payout threshold not reached`;
    blockingSettlement = true;
  }

  return {
    generated_at,
    overall_status,
    alert_level,
    total_findings: consolidatedFindings.length,
    critical_count: criticalCount,
    warning_count: warningCount,
    info_count: infoCount,
    agent_results: agentResults,
    consolidated_findings: consolidatedFindings,
    top_actions: topActions,
    fund_flow_summary: {
      confirmed_revenue_cents: confirmedCents,
      available_for_payout_cents: confirmedCents, // simplified
      paid_out_revenue_cents: paidOutCents,
      settled_cents: settlementStats.settled_amount_cents,
      pending_settlement_cents: settlementStats.pending_amount_cents,
      externally_confirmed_cents: 0, // tracked separately
      open_payout_batches: openBatches,
      total_payout_items: payoutItems.length,
      total_revenue_events: revenueEvents.length,
      owner_recipients_count: recipients.length,
    },
    bottleneck: {
      layer: bottleneckLayer,
      description: bottleneckDesc,
      blocking_settlement: blockingSettlement,
    },
  };
}

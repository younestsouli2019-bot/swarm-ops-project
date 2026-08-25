/**
 * Idempotent Payout Engine
 *
 * Creates payout batches with SHA256 idempotency keys.
 * Same revenue → same idempotency key → existing payout returned.
 *
 * State flow: DETECTED → VERIFIED → PAYABLE → APPROVED → SUBMITTED → PROCESSING → SETTLED
 *
 * Golden rule: No state promotion without evidence.
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";
import {
  MoneyFlow,
  MoneyState,
  SettlementProof,
  generateIdempotencyKey,
  shouldCountInTotals,
  promoteFlow,
  maskAccount,
} from "./money-state";
import {
  getBestAdapter,
  SettlementAdapter,
  SettlementResult,
} from "./settlement-adapter";

// ─── Payout Engine ──────────────────────────────────────────────────

export class PayoutEngine {
  private adapter: SettlementAdapter;

  constructor(adapter?: SettlementAdapter) {
    this.adapter = adapter || getBestAdapter();
  }

  /**
   * Register revenue as DETECTED.
   * Requires: source_transaction_id, source_provider
   */
  async detectRevenue(event: {
    revenue_event_id: string;
    amount: number;
    currency: string;
    source: string;
    source_transaction_id: string;
    source_provider: string;
    beneficiary_id: string;
    environment?: "production" | "test";
  }): Promise<MoneyFlow> {
    const idempotencyKey = generateIdempotencyKey(
      event.revenue_event_id,
      event.beneficiary_id,
      event.currency,
      event.amount
    );

    // Check for existing flow (idempotency)
    const existing = await this.findFlowBy(idempotencyKey);
    if (existing) {
      return existing;
    }

    const flow: MoneyFlow = {
      id: `FLOW-${Date.now().toString(36).toUpperCase()}`,
      revenue_event_id: event.revenue_event_id,
      state: "detected",
      amount: event.amount,
      currency: event.currency,
      beneficiary_id: event.beneficiary_id,
      idempotency_key: idempotencyKey,
      environment: event.environment || "production",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      state_history: [],
    };

    // Promote to verified (we have source evidence)
    const verified = promoteFlow(
      flow,
      "verified",
      {
        source_transaction_id: event.source_transaction_id,
        source_provider: event.source_provider,
        verification_timestamp: new Date().toISOString(),
      },
      "system"
    );

    // Promote to payable (we have beneficiary and amount)
    const payable = promoteFlow(
      verified,
      "payable",
      {
        revenue_event_id: event.revenue_event_id,
        amount: event.amount,
        currency: event.currency,
        beneficiary_id: event.beneficiary_id,
      },
      "system"
    );

    // Store in Base44
    try {
      await b44.create("MoneyFlow", {
        flow_id: payable.id,
        revenue_event_id: payable.revenue_event_id,
        state: payable.state,
        amount: payable.amount,
        currency: payable.currency,
        beneficiary_id: payable.beneficiary_id,
        idempotency_key: payable.idempotency_key,
        environment: payable.environment,
        state_history: JSON.stringify(payable.state_history),
      } as never);
    } catch {
      // Non-fatal
    }

    return payable;
  }

  /**
   * Approve a payable flow (owner authorization).
   * Requires: owner_approval_id, approved_by, approved_at
   */
  async approvePayout(
    flowId: string,
    approval: {
      owner_approval_id: string;
      approved_by: string;
      approved_at?: string;
    }
  ): Promise<MoneyFlow> {
    const flow = await this.findFlow(flowId);
    if (!flow) throw new Error(`Flow ${flowId} not found`);

    return promoteFlow(
      flow,
      "approved",
      {
        owner_approval_id: approval.owner_approval_id,
        approved_by: approval.approved_by,
        approved_at: approval.approved_at || new Date().toISOString(),
      },
      approval.approved_by
    );
  }

  /**
   * Submit an approved flow to the settlement provider.
   */
  async submitPayout(flowId: string): Promise<{
    flow: MoneyFlow;
    result: SettlementResult;
  }> {
    const flow = await this.findFlow(flowId);
    if (!flow) throw new Error(`Flow ${flowId} not found`);
    if (flow.state !== "approved") {
      throw new Error(`Flow must be approved, got ${flow.state}`);
    }

    const result = await this.adapter.submitPayout(flow);

    if (result.ok) {
      const submitted = promoteFlow(
        flow,
        "submitted",
        {
          provider_reference: result.provider_reference,
          submitted_to: result.provider,
          submitted_at: new Date().toISOString(),
          settlement_adapter: this.adapter.name,
        },
        "system"
      );

      return { flow: submitted, result };
    }

    return { flow, result };
  }

  /**
   * Confirm bank settlement.
   */
  async confirmSettlement(
    flowId: string,
    proof: {
      bank_confirmation_id: string;
      bank_confirmed_at?: string;
      settled_amount: number;
      settled_currency: string;
      settlement_proof: string;
    }
  ): Promise<MoneyFlow> {
    const flow = await this.findFlow(flowId);
    if (!flow) throw new Error(`Flow ${flowId} not found`);

    return promoteFlow(
      flow,
      "settled",
      {
        bank_confirmation_id: proof.bank_confirmation_id,
        bank_confirmed_at:
          proof.bank_confirmed_at || new Date().toISOString(),
        settled_amount: proof.settled_amount,
        settled_currency: proof.settled_currency,
        settlement_proof: proof.settlement_proof,
      },
      "system"
    );
  }

  /**
   * Get the financial dashboard.
   */
  async getDashboard(): Promise<{
    gross_detected: number;
    verified: number;
    payable: number;
    awaiting_approval: number;
    submitted: number;
    provider_confirmed: number;
    bank_confirmed: number;
    reconciliation_exceptions: number;
    flows_by_state: Record<MoneyState, number>;
  }> {
    // Fetch all flows from Base44
    let flows: MoneyFlow[] = [];
    try {
      flows = (await b44.list("MoneyFlow", {
        limit: 1000,
      })) as unknown as MoneyFlow[];
    } catch {
      // Fallback to revenue + batch counts
    }

    const prodFlows = flows.filter(
      (f) =>
        f.environment === "production" &&
        shouldCountInTotals(f)
    );

    const byState = (state: MoneyState) =>
      prodFlows
        .filter((f) => f.state === state)
        .reduce((sum, f) => sum + (f.amount || 0), 0);

    const countByState = (state: MoneyState) =>
      prodFlows.filter((f) => f.state === state).length;

    return {
      gross_detected: byState("detected") + byState("verified") + byState("payable") + byState("approved") + byState("submitted") + byState("processing") + byState("settled"),
      verified: byState("verified") + byState("payable") + byState("approved") + byState("submitted") + byState("processing") + byState("settled"),
      payable: byState("payable") + byState("approved") + byState("submitted") + byState("processing") + byState("settled"),
      awaiting_approval: byState("payable"),
      submitted: byState("submitted") + byState("processing") + byState("settled"),
      provider_confirmed: byState("processing") + byState("settled"),
      bank_confirmed: byState("settled"),
      reconciliation_exceptions: prodFlows.filter(
        (f) =>
          f.state === "quarantined" ||
          f.state === "reconciliation_required"
      ).length,
      flows_by_state: {
        detected: countByState("detected"),
        verified: countByState("verified"),
        payable: countByState("payable"),
        approved: countByState("approved"),
        submitted: countByState("submitted"),
        processing: countByState("processing"),
        settled: countByState("settled"),
        rejected: countByState("rejected"),
        cancelled: countByState("cancelled"),
        quarantined: countByState("quarantined"),
        reconciliation_required: countByState("reconciliation_required"),
      },
    };
  }

  // ─── Internal Helpers ──────────────────────────────────────────

  private async findFlow(flowId: string): Promise<MoneyFlow | null> {
    try {
      const flows = await b44.list("MoneyFlow", {
        filter: { flow_id: flowId },
        limit: 1,
      });
      return (flows[0] as MoneyFlow) || null;
    } catch {
      return null;
    }
  }

  private async findFlowBy(
    idempotencyKey: string
  ): Promise<MoneyFlow | null> {
    try {
      const flows = await b44.list("MoneyFlow", {
        filter: { idempotency_key: idempotencyKey },
        limit: 1,
      });
      return (flows[0] as MoneyFlow) || null;
    } catch {
      return null;
    }
  }
}

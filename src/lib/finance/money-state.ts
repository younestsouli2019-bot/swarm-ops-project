/**
 * Financial Control Plane — Money State Model
 *
 * Golden rule: No component is allowed to promote money from one state
 * to the next without evidence.
 *
 * ACTIVE STATES (money flows through these):
 *   DETECTED → VERIFIED → PAYABLE → APPROVED → SUBMITTED → PROCESSING → SETTLED
 *
 * TERMINAL STATES (money stopped here):
 *   REJECTED | CANCELLED | QUARANTINED | RECONCILIATION_REQUIRED
 */

// ─── State Enums ────────────────────────────────────────────────────

export type MoneyState =
  | "detected"
  | "verified"
  | "payable"
  | "approved"
  | "submitted"
  | "processing"
  | "settled"
  | "rejected"
  | "cancelled"
  | "quarantined"
  | "reconciliation_required";

export type TerminalState =
  | "rejected"
  | "cancelled"
  | "quarantined"
  | "reconciliation_required";

export const ACTIVE_STATES: MoneyState[] = [
  "detected",
  "verified",
  "payable",
  "approved",
  "submitted",
  "processing",
  "settled",
];

export const TERMINAL_STATES: TerminalState[] = [
  "rejected",
  "cancelled",
  "quarantined",
  "reconciliation_required",
];

// ─── Valid Transitions ──────────────────────────────────────────────
// Each state can only move to specific next states.
// Evidence is required for every transition.

const VALID_TRANSITIONS: Record<MoneyState, MoneyState[]> = {
  detected: ["verified", "rejected", "quarantined"],
  verified: ["payable", "rejected", "quarantined"],
  payable: ["approved", "rejected", "cancelled"],
  approved: ["submitted", "cancelled"],
  submitted: ["processing", "reconciliation_required"],
  processing: ["settled", "reconciliation_required"],
  settled: [], // terminal — money arrived
  rejected: [], // terminal — won't pay
  cancelled: [], // terminal — owner cancelled
  quarantined: ["detected", "rejected"], // can be re-examined
  reconciliation_required: ["processing", "quarantined"], // retry or escalate
};

// ─── Evidence Requirements ──────────────────────────────────────────
// What proof is needed to promote from one state to the next.

export interface TransitionEvidence {
  from: MoneyState;
  to: MoneyState;
  required_fields: string[];
  description: string;
}

export const TRANSITION_EVIDENCE: TransitionEvidence[] = [
  {
    from: "detected",
    to: "verified",
    required_fields: [
      "source_transaction_id",
      "source_provider",
      "verification_timestamp",
    ],
    description:
      "Revenue source confirmed — transaction ID exists at provider",
  },
  {
    from: "verified",
    to: "payable",
    required_fields: [
      "revenue_event_id",
      "amount",
      "currency",
      "beneficiary_id",
    ],
    description:
      "Revenue is real, amount confirmed, beneficiary identified",
  },
  {
    from: "payable",
    to: "approved",
    required_fields: ["owner_approval_id", "approved_by", "approved_at"],
    description: "Owner has authorized this payout",
  },
  {
    from: "approved",
    to: "submitted",
    required_fields: [
      "provider_reference",
      "submitted_to",
      "submitted_at",
      "settlement_adapter",
    ],
    description:
      "Payout submitted to payment provider (Payoneer/Banking Circle)",
  },
  {
    from: "submitted",
    to: "processing",
    required_fields: ["provider_status", "provider_confirmed_at"],
    description: "Provider confirmed they are processing the transfer",
  },
  {
    from: "processing",
    to: "settled",
    required_fields: [
      "bank_confirmation_id",
      "bank_confirmed_at",
      "settled_amount",
      "settled_currency",
      "settlement_proof",
    ],
    description: "Bank confirmed funds arrived in owner account",
  },
];

// ─── Core Types ─────────────────────────────────────────────────────

export interface SettlementProof {
  payout_id: string;
  status: MoneyState;
  requested_amount: number;
  requested_currency: string;
  destination: string;
  provider: string;
  provider_reference?: string;
  submitted_at?: string;
  provider_confirmed_at?: string;
  bank_confirmed_at?: string;
  settlement_proof?: string;
  reconciled: boolean;
  environment: "production" | "test";
}

export interface MoneyFlow {
  id: string;
  revenue_event_id: string;
  state: MoneyState;
  amount: number;
  currency: string;
  beneficiary_id: string;
  idempotency_key: string;
  environment: "production" | "test";
  created_at: string;
  updated_at: string;
  state_history: StateTransition[];
  settlement_proof?: SettlementProof;
}

export interface StateTransition {
  from: MoneyState;
  to: MoneyState;
  timestamp: string;
  evidence: Record<string, unknown>;
  actor: string; // "system" | "owner" | "reconciliation"
}

// ─── State Machine ──────────────────────────────────────────────────

export function canTransition(
  from: MoneyState,
  to: MoneyState
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getRequiredEvidence(
  from: MoneyState,
  to: MoneyState
): TransitionEvidence | undefined {
  return TRANSITION_EVIDENCE.find(
    (e) => e.from === from && e.to === to
  );
}

export function validateTransition(
  flow: MoneyFlow,
  to: MoneyState,
  evidence: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!canTransition(flow.state, to)) {
    errors.push(
      `Cannot transition from ${flow.state} to ${to}`
    );
  }

  const required = getRequiredEvidence(flow.state, to);
  if (required) {
    for (const field of required.required_fields) {
      if (
        evidence[field] === undefined ||
        evidence[field] === null ||
        evidence[field] === ""
      ) {
        errors.push(`Missing required evidence: ${field}`);
      }
    }
  }

  if (flow.environment === "test") {
    errors.push("Test flows cannot be promoted to settled");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Promote a money flow to the next state.
 * Returns the updated flow, or throws if transition is invalid.
 */
export function promoteFlow(
  flow: MoneyFlow,
  to: MoneyState,
  evidence: Record<string, unknown>,
  actor: string = "system"
): MoneyFlow {
  const validation = validateTransition(flow, to, evidence);
  if (!validation.valid) {
    throw new Error(
      `Transition rejected: ${validation.errors.join("; ")}`
    );
  }

  const transition: StateTransition = {
    from: flow.state,
    to,
    timestamp: new Date().toISOString(),
    evidence,
    actor,
  };

  return {
    ...flow,
    state: to,
    updated_at: new Date().toISOString(),
    state_history: [...flow.state_history, transition],
  };
}

// ─── Idempotency Key ────────────────────────────────────────────────
import { createHash } from "crypto";

export function generateIdempotencyKey(
  revenue_event_id: string,
  beneficiary_id: string,
  currency: string,
  amount: number
): string {
  const input = `${revenue_event_id}:${beneficiary_id}:${currency}:${amount}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── Environment Guard ──────────────────────────────────────────────

export function isTestFlow(flow: MoneyFlow): boolean {
  return flow.environment === "test";
}

export function shouldCountInTotals(flow: MoneyFlow): boolean {
  return flow.environment === "production" && flow.state !== "cancelled";
}

// ─── Masking Utilities ──────────────────────────────────────────────

export function maskAccount(account: string): string {
  if (account.length <= 8) return "****";
  return (
    account.slice(0, 4) +
    "*".repeat(account.length - 8) +
    account.slice(-4)
  );
}

export function maskIBAN(iban: string): string {
  if (iban.length <= 8) return "****";
  return (
    iban.slice(0, 4) +
    "*".repeat(iban.length - 8) +
    iban.slice(-4)
  );
}

export function maskAmount(amount: number): string {
  return amount.toFixed(2);
}

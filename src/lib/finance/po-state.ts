/**
 * Procurement State Machine
 *
 * PO lifecycle: CREATED → APPROVED → ORDERED → PAID → SHIPPED → DELIVERED → CONFIRMED
 *
 * Terminal states: CANCELLED | DISPUTED | REFUNDED | QUARANTINED
 *
 * Golden rule: No state promotion without evidence.
 * Every transition requires a SettlementProof-like record.
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";
import {
  maskAccount,
  maskIBAN,
} from "./money-state";

// ─── PO State Model ─────────────────────────────────────────────────

export type POState =
  | "created"
  | "approved"
  | "ordered"
  | "paid"
  | "shipped"
  | "delivered"
  | "confirmed"
  | "cancelled"
  | "disputed"
  | "refunded"
  | "quarantined";

export type POTerminalState =
  | "cancelled"
  | "disputed"
  | "refunded"
  | "quarantined";

export const PO_ACTIVE_STATES: POState[] = [
  "created",
  "approved",
  "ordered",
  "paid",
  "shipped",
  "delivered",
  "confirmed",
];

export const PO_TERMINAL_STATES: POTerminalState[] = [
  "cancelled",
  "disputed",
  "refunded",
  "quarantined",
];

// ─── Valid Transitions ──────────────────────────────────────────────

const PO_VALID_TRANSITIONS: Record<POState, POState[]> = {
  created: ["approved", "cancelled", "quarantined"],
  approved: ["ordered", "cancelled"],
  ordered: ["paid", "cancelled", "disputed"],
  paid: ["shipped", "disputed", "refunded"],
  shipped: ["delivered", "disputed"],
  delivered: ["confirmed", "disputed"],
  confirmed: [], // terminal — PO complete
  cancelled: [], // terminal
  disputed: ["refunded", "quarantined"], // can be resolved
  refunded: [], // terminal
  quarantined: ["created", "cancelled"], // can be re-examined
};

// ─── Evidence Requirements ──────────────────────────────────────────

export interface POTransitionEvidence {
  from: POState;
  to: POState;
  required_fields: string[];
  description: string;
}

export const PO_TRANSITION_EVIDENCE: POTransitionEvidence[] = [
  {
    from: "created",
    to: "approved",
    required_fields: ["approved_by", "approved_at", "approval_id"],
    description: "Owner approved the procurement order",
  },
  {
    from: "approved",
    to: "ordered",
    required_fields: ["order_id", "ordered_at", "supplier_id"],
    description: "Order placed with supplier",
  },
  {
    from: "ordered",
    to: "paid",
    required_fields: [
      "payment_id",
      "paid_amount",
      "paid_currency",
      "paid_at",
      "payment_method",
    ],
    description: "Payment sent to supplier",
  },
  {
    from: "paid",
    to: "shipped",
    required_fields: ["tracking_id", "shipped_at", "carrier"],
    description: "Supplier shipped the items",
  },
  {
    from: "shipped",
    to: "delivered",
    required_fields: ["delivery_confirmation", "delivered_at", "received_by"],
    description: "Items received by recipient",
  },
  {
    from: "delivered",
    to: "confirmed",
    required_fields: ["confirmation_id", "confirmed_at", "quality_check"],
    description: "Recipient confirmed items match order",
  },
];

// ─── Core Types ─────────────────────────────────────────────────────

export interface POSettlementProof {
  po_id: string;
  status: POState;
  order_id?: string;
  payment_id?: string;
  tracking_id?: string;
  delivery_confirmation?: string;
  confirmation_id?: string;
  requested_amount: number;
  requested_currency: string;
  paid_amount?: number;
  paid_currency?: string;
  paid_at?: string;
  payment_method?: string;
  supplier_id: string;
  recipient_id: string;
  reconciled: boolean;
  environment: "production" | "test";
}

export interface ProcurementFlow {
  id: string;
  po_id: string;
  state: POState;
  amount: number;
  currency: string;
  supplier_id: string;
  recipient_id: string;
  idempotency_key: string;
  environment: "production" | "test";
  created_at: string;
  updated_at: string;
  state_history: POTransition[];
  settlement_proof?: POSettlementProof;
}

export interface POTransition {
  from: POState;
  to: POState;
  timestamp: string;
  evidence: Record<string, unknown>;
  actor: string;
}

// ─── State Machine ──────────────────────────────────────────────────

export function canPOTransition(from: POState, to: POState): boolean {
  return PO_VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getPORequiredEvidence(
  from: POState,
  to: POState
): POTransitionEvidence | undefined {
  return PO_TRANSITION_EVIDENCE.find(
    (e) => e.from === from && e.to === to
  );
}

export function validatePOTransition(
  flow: ProcurementFlow,
  to: POState,
  evidence: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!canPOTransition(flow.state, to)) {
    errors.push(
      `Cannot transition PO from ${flow.state} to ${to}`
    );
  }

  const required = getPORequiredEvidence(flow.state, to);
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
    errors.push("Test POs cannot be confirmed");
  }

  return { valid: errors.length === 0, errors };
}

export function promotePOFlow(
  flow: ProcurementFlow,
  to: POState,
  evidence: Record<string, unknown>,
  actor: string = "system"
): ProcurementFlow {
  const validation = validatePOTransition(flow, to, evidence);
  if (!validation.valid) {
    throw new Error(
      `PO transition rejected: ${validation.errors.join("; ")}`
    );
  }

  const transition: POTransition = {
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

export function generatePOIdempotencyKey(
  po_id: string,
  supplier_id: string,
  recipient_id: string,
  amount: number,
  currency: string
): string {
  const input = `${po_id}:${supplier_id}:${recipient_id}:${amount}:${currency}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── PO Dashboard ───────────────────────────────────────────────────

export interface PODashboard {
  title: string;
  summary: {
    total_pos: number;
    created: number;
    approved: number;
    ordered: number;
    paid: number;
    shipped: number;
    delivered: number;
    confirmed: number;
    cancelled: number;
    disputed: number;
    refunded: number;
    quarantined: number;
  };
  financials: {
    total_order_value: number;
    total_paid: number;
    total_refunded: number;
    pending_payments: number;
    pending_deliveries: number;
  };
  by_recipient: Record<
    string,
    {
      total_pos: number;
      total_value: number;
      confirmed: number;
      pending: number;
    }
  >;
  by_supplier: Record<
    string,
    {
      total_pos: number;
      total_value: number;
      confirmed: number;
      pending: number;
    }
  >;
  exceptions: number;
}

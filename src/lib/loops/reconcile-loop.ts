/**
 * RECONCILE LOOP — assesses global swarm state vs desired state.
 *
 * Layer 1 of the autonomous daemon fan-out.
 * Responsibilities:
 *   - Pull live PayoutBatch / PayoutItem state from Base44
 *   - Detect batches claiming completion without real external proof
 *   - Detect stale / stuck pipeline states
 *   - Return a normalized snapshot the guard + delivery loop can consume
 *
 * Read-only by default: this loop ASSESSES, it does not mutate. The
 * delivery loop performs the mutations only after verifyPayoutGuard()
 * passes.
 */

import { b44 } from "../base44";

export interface ReconcileLoopResult {
  ok: boolean;
  timestamp: string;
  duration_ms: number;
  assessed: {
    total_batches: number;
    total_items: number;
    by_batch_status: Record<string, number>;
    by_item_status: Record<string, number>;
  };
  anomalies: Array<{
    severity: "info" | "warning" | "critical";
    kind: string;
    batch_id?: string;
    detail: string;
  }>;
  flags: {
    unproven_completed_batches: string[];
    stuck_pipeline_batches: string[];
    empty_approved_batches: string[];
  };
  error?: string;
}

const STUCK_HOURS = 48;

/**
 * Determine whether a proof payload looks like a REAL external proof
 * vs an internal/fabricated ID. Mirrors the deny-list + allow-list
 * from scripts/fraud-audit-baseline.mjs.
 */
export function isRealProof(proofPayload: string, proofKind?: string): boolean {
  if (!proofPayload) return false;
  const p = String(proofPayload).trim();
  if (!p) return false;

  // Deny-list: internal / fabricated signatures
  const FABRICATED = [
    /^txn_[a-z0-9]{1,10}$/i,
    /^PB-\d+$/i,
    /^PI-\w+$/i,
    /^REV-\w+$/i,
    /^PROC-\w+$/i,
    // a bare reference with no context and no known prefix
    /^(rev|pb|pi|proc|txn)[-:]/i,
  ];
  for (const f of FABRICATED) if (f.test(p)) return false;

  // Allow-list: real external proof signatures
  const REAL = [
    /[0-9a-f]{64}/i,          // on-chain tx hash
    /ch_[a-z0-9]+/i,          // Stripe charge
    /pi_[a-z0-9]+/i,          // Stripe payment intent
    /py_[a-z0-9]+/i,          // Stripe payment
    /PAYID-[A-Z0-9]+/i,       // PayPal
    /wisepay/i,               // Wise
    /transfer[_ -]?id/i,      // rail transfer id reference
    /transaction[_ -]?id/i,   // rail transaction id
    /external[_ -]?ref/i,     // rail external ref
    /bank_statement/i,        // bank statement context
    /[0-9]{8,17}/,            // ACH trace / bank reference number
  ];
  for (const r of REAL) if (r.test(p)) return true;

  // transfer_initiated proofs carry a structured transfer_id
  if (proofKind === "transfer_initiated") {
    try {
      const parsed = JSON.parse(p);
      if (parsed.transfer_id && String(parsed.transfer_id).length > 5) return true;
    } catch {
      /* not JSON — fall through */
    }
  }
  return false;
}

export async function runReconcileLoop(): Promise<ReconcileLoopResult> {
  const start = Date.now();
  const result: ReconcileLoopResult = {
    ok: false,
    timestamp: new Date().toISOString(),
    duration_ms: 0,
    assessed: {
      total_batches: 0,
      total_items: 0,
      by_batch_status: {},
      by_item_status: {},
    },
    anomalies: [],
    flags: {
      unproven_completed_batches: [],
      stuck_pipeline_batches: [],
      empty_approved_batches: [],
    },
  };

  try {
    const batches = (await b44.list("PayoutBatch", { limit: 200 })) as any[];
    result.assessed.total_batches = batches.length;

    for (const batch of batches) {
      const status = String(batch.status || "unknown").toLowerCase();
      result.assessed.by_batch_status[status] =
        (result.assessed.by_batch_status[status] || 0) + 1;

      let items: any[] = [];
      try {
        const allItems = (await b44.list("PayoutItem", { limit: 500 })) as any[];
        items = allItems.filter((i) => String(i.batch_id) === String(batch.id));
      } catch {
        items = [];
      }
      result.assessed.total_items += items.length;
      for (const item of items) {
        const ist = String(item.status || "unknown").toLowerCase();
        result.assessed.by_item_status[ist] =
          (result.assessed.by_item_status[ist] || 0) + 1;
      }

      // 1. Completed/submitted batches that carry NO real external proof
      if (status === "completed" || status === "submitted") {
        const hasAnyProof = items.some((item: any) => {
          const meta = item.metadata
            ? typeof item.metadata === "string"
              ? tryParse(item.metadata)
              : item.metadata
            : {};
          const kind = meta.proof_kind || item.proof_kind || "";
          const payload =
            meta.proof_payload || item.proof_payload || meta.external_transaction_id || item.external_transaction_id || "";
          return isRealProof(payload, kind);
        });
        if (!hasAnyProof && items.length > 0) {
          result.flags.unproven_completed_batches.push(batch.id);
          result.anomalies.push({
            severity: "critical",
            kind: "unproven_completed_batch",
            batch_id: batch.id,
            detail: `Batch ${batch.id} is '${status}' with ${items.length} items but no real external proof.`,
          });
        }
      }

      // 2. Approved batches with zero items (would be flagged by settlement)
      if (status === "approved" && items.length === 0) {
        result.flags.empty_approved_batches.push(batch.id);
        result.anomalies.push({
          severity: "warning",
          kind: "empty_approved_batch",
          batch_id: batch.id,
          detail: `Batch ${batch.id} is 'approved' but has no PayoutItems.`,
        });
      }

      // 3. Pipeline-stuck batches (processing / submitted_to_paypal beyond threshold)
      const batchUpdateTs =
        batch.updated_date || batch.updatedAt || batch.processed_at || batch.created_date;
      if (
        (status === "processing" || status === "submitted_to_paypal") &&
        batchUpdateTs
      ) {
        const ageHours =
          (Date.now() - new Date(batchUpdateTs).getTime()) / 3600_000;
        if (ageHours > STUCK_HOURS) {
          result.flags.stuck_pipeline_batches.push(batch.id);
          result.anomalies.push({
            severity: "warning",
            kind: "stuck_pipeline_batch",
            batch_id: batch.id,
            detail: `Batch ${batch.id} stuck in '${status}' for ${Math.round(
              ageHours
            )}h (>${STUCK_HOURS}h).`,
          });
        }
      }
    }

    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.anomalies.push({
      severity: "critical",
      kind: "reconcile_loop_error",
      detail: result.error,
    });
  }

  result.duration_ms = Date.now() - start;
  return result;
}

function tryParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

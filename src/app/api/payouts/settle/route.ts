/**
 * POST /api/payouts/settle
 *
 * Transition a payout from `submitted` → `settled`.
 *
 * CRITICAL GUARD: requires real external proof. Acceptable proof kinds:
 *   - "webhook_verified"        — a verified PSP webhook payload
 *   - "bank_statement_match"    — a matched bank statement line (from reconcile tool)
 *   - "on_chain_confirmation"   — a real blockchain transaction hex
 *
 * The receipt_hash is the SHA-256 of the proof_payload. This hash is
 * what gets stamped on the RevenueEvent's metadata.external_confirmation_ref
 * and what the fraud audit baseline checks against real-proof patterns.
 *
 * NO SIMULATION. If proof_payload is empty, the call fails.
 */

import { NextResponse } from "next/server";
import { settlePayout } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: {
    payout_id?: string;
    proof_kind?: "webhook_verified" | "bank_statement_match" | "on_chain_confirmation";
    proof_payload?: string;
    receipt_hash?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.payout_id) {
    return NextResponse.json({ error: "payout_id is required" }, { status: 400 });
  }
  if (!body.proof_kind) {
    return NextResponse.json(
      {
        error:
          "proof_kind is required (webhook_verified | bank_statement_match | on_chain_confirmation)",
      },
      { status: 400 }
    );
  }
  if (!body.proof_payload || body.proof_payload.trim().length === 0) {
    return NextResponse.json(
      { error: "proof_payload is required — no simulation allowed", code: "no_proof" },
      { status: 400 }
    );
  }

  const result = settlePayout({
    payout_id: body.payout_id,
    actor: "api:/api/payouts/settle",
    reason: body.reason,
    proof_kind: body.proof_kind,
    proof_payload: body.proof_payload,
    receipt_hash: body.receipt_hash,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    payout: result.payout,
    receipt_hash: result.receipt_hash,
  });
}

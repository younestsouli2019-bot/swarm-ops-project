/**
 * POST /api/payouts/reconcile
 *
 * Transition a payout from `settled` → `reconciled`.
 *
 * This is the terminal "real money arrived" state. The payout must have
 * already been settled (rail confirmed), and we must now have matched it
 * against an imported bank statement line via SHA-256 correlation ID.
 *
 * The bank_statement_ref is the bank's own transaction id (from the
 * statement), not our internal id.
 */

import { NextResponse } from "next/server";
import { reconcilePayout } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: {
    payout_id?: string;
    bank_statement_ref?: string;
    bank_statement_line?: string;
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
  if (!body.bank_statement_ref) {
    return NextResponse.json(
      { error: "bank_statement_ref is required (the bank's own transaction id from the statement)" },
      { status: 400 }
    );
  }
  if (!body.bank_statement_line) {
    return NextResponse.json(
      { error: "bank_statement_line is required (the raw line from the statement for audit)" },
      { status: 400 }
    );
  }

  const result = reconcilePayout({
    payout_id: body.payout_id,
    actor: "api:/api/payouts/reconcile",
    bank_statement_ref: body.bank_statement_ref,
    bank_statement_line: body.bank_statement_line,
    reason: body.reason,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }
  return NextResponse.json({ ok: true, payout: result.payout });
}

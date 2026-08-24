/**
 * POST /api/payouts/webhook/attijari
 *
 * Receives webhook callbacks from Attijariwafa Bank when a transfer
 * reaches a terminal state (completed/failed). Updates payout records.
 */

import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { b44 } from "@/lib/base44";
import { settlePayout, failPayout, getPayout } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.ATTIJARI_WEBHOOK_SECRET || process.env.ATTIJARI_CLIENT_SECRET || "";

function verifySignature(payload: string, signature: string, timestamp: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}:${payload}`)
    .digest("hex");
  return expected === signature;
}

interface WebhookPayload {
  event_type: "transfer.completed" | "transfer.failed" | "transfer.cancelled";
  transaction_id: string;
  status: string;
  failure_reason?: string;
  end_to_end_id?: string;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-timestamp") || "";
  const signature = request.headers.get("x-signature") || "";

  if (!verifySignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try { payload = JSON.parse(rawBody); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event_type, transaction_id, status, failure_reason } = payload;

  // Find matching payout by external_reference
  const payout = getPayout(transaction_id);

  if (!payout) {
    return NextResponse.json({
      ok: true, message: "No matching payout", transaction_id,
    });
  }

  if (event_type === "transfer.completed" || status === "completed") {
    settlePayout({
      payout_id: payout.id,
      actor: "webhook:/api/payouts/webhook/attijari",
      reason: `Attijariwafa confirmed: ${transaction_id}`,
      proof_kind: "webhook_verified",
      proof_payload: JSON.stringify(payload),
    });
    try {
      await b44.update("PayoutItem", payout.id, {
        status: "success",
        external_transaction_id: transaction_id,
        processed_at: new Date().toISOString(),
      } as never);
    } catch { /* best-effort */ }
  } else if (event_type === "transfer.failed" || status === "failed") {
    failPayout({
      payout_id: payout.id,
      actor: "webhook:/api/payouts/webhook/attijari",
      reason: failure_reason || "Transfer failed",
    });
  }

  return NextResponse.json({ ok: true, transaction_id, event_type, payout_id: payout.id });
}

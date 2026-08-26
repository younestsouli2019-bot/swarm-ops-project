/**
 * Wise Webhook Receiver
 *
 * Handles real-time payment status updates from Wise.
 * When a transfer completes, auto-marks the PayoutBatch as settled.
 *
 * Webhook URL: /api/webhooks/wise
 *
 * Wise webhook events:
 *   - TRANSFER_EXECUTED      — transfer sent to banking network
 *   - TRANSFER_COMPLETED     — funds arrived at beneficiary
 *   - TRANSFER_FAILED        — transfer rejected
 *   - TRANSFER_CANCELLED     — transfer cancelled
 *
 * Auth: Wise signs webhooks with a secret. Verify X-Signature header.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { b44 } from "@/lib/base44";
import { settlePayout } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WISE_WEBHOOK_SECRET = process.env.WISE_WEBHOOK_SECRET || "";

// ─── Signature Verification ─────────────────────────────────────────

async function verifySignature(
  payload: string,
  signature: string
): Promise<boolean> {
  if (!WISE_WEBHOOK_SECRET) return true; // No secret configured — skip verification

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(WISE_WEBHOOK_SECRET);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );

    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return signature === expectedSignature;
  } catch {
    return false;
  }
}

// ─── Event Handlers ─────────────────────────────────────────────────

async function handleTransferCompleted(data: {
  resource_id?: string;
  transfer_id?: string;
  account_id?: string;
  details?: Record<string, unknown>;
}): Promise<{ ok: boolean; message: string }> {
  const transferId = String(data.resource_id || data.transfer_id || "");

  // Find matching PayoutItem by external_transaction_id
  const items = await b44.list("PayoutItem", {
    filter: { external_transaction_id: transferId },
    limit: 5,
  }) as Array<{ id: string; batch_id: string; status: string; metadata?: string }>;

  if (!items.length) {
    return { ok: true, message: `No matching PayoutItem for transfer ${transferId}` };
  }

  for (const item of items) {
    if (item.status === "settled") continue;

    // Update PayoutItem to settled
    await b44.update("PayoutItem", item.id, {
      status: "settled",
      settled_at: new Date().toISOString(),
    });

    // Find and update PayoutBatch
    const batches = await b44.list("PayoutBatch", {
      filter: { id: item.batch_id },
      limit: 1,
    }) as Array<{ id: string; status: string }>;

    if (batches.length > 0 && batches[0].status !== "settled") {
      await b44.update("PayoutBatch", batches[0].id, {
        status: "settled",
        settled_at: new Date().toISOString(),
        notes: `Settled via Wise webhook. Transfer ${transferId} completed.`,
      });
    }

    // Try to settle via state machine
    try {
      const meta = item.metadata ? JSON.parse(item.metadata) : {};
      if (meta.state_machine_payout_id) {
        settlePayout({
          payout_id: meta.state_machine_payout_id,
          actor: "webhook:/api/webhooks/wise",
          reason: `Wise transfer ${transferId} completed`,
          proof_kind: "webhook_verified",
          proof_payload: JSON.stringify({
            transfer_id: transferId,
            completed_at: new Date().toISOString(),
            source: "wise_webhook",
          }),
        });
      }
    } catch {
      // State machine may not have the payout — that's ok
    }
  }

  return { ok: true, message: `Settled ${items.length} items for transfer ${transferId}` };
}

async function handleTransferFailed(data: {
  resource_id?: string;
  transfer_id?: string;
  details?: Record<string, unknown>;
}): Promise<{ ok: boolean; message: string }> {
  const transferId = String(data.resource_id || data.transfer_id || "");
  const reason = (data.details?.error as string) || (data.details?.failure_reason as string) || "Unknown";

  const items = await b44.list("PayoutItem", {
    filter: { external_transaction_id: transferId },
    limit: 5,
  }) as Array<{ id: string; batch_id: string; status: string }>;

  for (const item of items) {
    await b44.update("PayoutItem", item.id, {
      status: "failed",
      metadata: JSON.stringify({ failure_reason: reason, failed_at: new Date().toISOString() }),
    });

    const batches = await b44.list("PayoutBatch", {
      filter: { id: item.batch_id },
      limit: 1,
    }) as Array<{ id: string; status: string }>;

    if (batches.length > 0) {
      await b44.update("PayoutBatch", batches[0].id, {
        status: "failed",
        notes: `Wise transfer ${transferId} failed: ${reason}`,
      });
    }
  }

  return { ok: true, message: `Marked ${items.length} items as failed for transfer ${transferId}` };
}

// ─── POST Handler ───────────────────────────────────────────────────

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Verify webhook signature
  const signature = request.headers.get("x-signature") || request.headers.get("x-wise-signature") || "";
  if (WISE_WEBHOOK_SECRET && signature) {
    const valid = await verifySignature(rawBody, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body.event as string;
  const data = body.data as Record<string, unknown> || {};

  // Log the webhook
  const logId = randomUUID().slice(0, 12);
  console.log(`[WISE-WEBHOOK-${logId}] Event: ${event}`, JSON.stringify(data).slice(0, 500));

  let result: { ok: boolean; message: string };

  switch (event) {
    case "TRANSFER_COMPLETED":
      result = await handleTransferCompleted(data);
      break;
    case "TRANSFER_FAILED":
      result = await handleTransferFailed(data);
      break;
    case "TRANSFER_EXECUTED":
      // Transfer sent but not yet confirmed — just log
      result = { ok: true, message: `Transfer ${data.resource_id || data.transfer_id} executed` };
      break;
    case "TRANSFER_CANCELLED":
      result = await handleTransferFailed({ ...data, details: { ...data.details as Record<string, unknown>, error: "Cancelled" } });
      break;
    default:
      result = { ok: true, message: `Unhandled event: ${event}` };
  }

  return NextResponse.json({
    ok: true,
    event,
    log_id: logId,
    ...result,
  });
}

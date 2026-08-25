/**
 * ChariBaaS Webhook Receiver
 *
 * Receives payment notifications from ChariBaaS.
 * Events: cashin.card.authorized, payment.card.authorized,
 *         cashin.network.executed, cashout.network.executed,
 *         operation.completed, operation.failed
 *
 * Reply 200 OK within 5 seconds.
 * Non-2xx triggers retry: 1m, 5m, 30m, 60m, then every 6h up to 72h.
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Webhook Event Types ────────────────────────────────────────────

interface ChariWebhookEvent {
  WebhookId: number;
  CRequestId?: string;
  OperationId: number;
  OperationType: number;
  OperationStatus: number;
  CreatedAt: string;
  ExecutedAt?: string;
  Amount: number;
  FeeAmount?: number;
  CustomData?: string;
  PrimaryAccountNumber?: string;
  Method?: string;
  GatewayTrackId?: string;
  GatewayOrderId?: string;
  GatewayReferenceId?: string;
  Reference?: string;
  NetworkName?: string;
}

// Operation types
const OP_TYPE: Record<number, string> = {
  1: "CASHIN",
  2: "CASHOUT",
  5: "MOBILE_PAYMENT",
  10: "RECHARGE",
  23: "VOUCHER",
  24: "CARD_PAYMENT",
  25: "BILL_PAYMENT",
};

// Operation statuses
const OP_STATUS: Record<number, string> = {
  1: "OPEN",
  2: "COMPLETED",
  3: "FAILED",
  4: "CANCELED",
};

// ─── POST Handler ───────────────────────────────────────────────────

export async function POST(request: Request) {
  const webhookId = request.headers.get("C-Webhook-Id") || "unknown";
  const apiKey = request.headers.get("X-Api-Key") || "";

  // Validate webhook API key
  const expectedKey = process.env.CHARIPAY_WEBHOOK_KEY;
  if (expectedKey && apiKey !== expectedKey) {
    return NextResponse.json(
      { ok: false, error: "Invalid webhook key" },
      { status: 401 }
    );
  }

  let event: ChariWebhookEvent;
  try {
    event = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Log webhook event
  const eventLog = {
    webhook_id: webhookId,
    event_type: `${OP_TYPE[event.OperationType] || "UNKNOWN"}.${OP_STATUS[event.OperationStatus] || "UNKNOWN"}`,
    operation_id: event.OperationId,
    operation_type: event.OperationType,
    operation_status: event.OperationStatus,
    amount: event.Amount,
    fee_amount: event.FeeAmount || 0,
    method: event.Method || "",
    reference: event.Reference || "",
    gateway_track_id: event.GatewayTrackId || "",
    gateway_order_id: event.GatewayOrderId || "",
    account: event.PrimaryAccountNumber || "",
    executed_at: event.ExecutedAt || "",
    raw_event: JSON.stringify(event),
  };

  // Persist to Base44
  try {
    await b44.create("WebhookEvent", {
      source: "charipay",
      webhook_id: webhookId,
      event_type: eventLog.event_type,
      operation_id: event.OperationId,
      amount: event.Amount,
      status: OP_STATUS[event.OperationStatus] || "UNKNOWN",
      reference: event.Reference || "",
      raw_data: JSON.stringify(event),
      received_at: new Date().toISOString(),
    } as never);
  } catch {
    // Non-fatal
  }

  // Process event based on type
  switch (eventLog.event_type) {
    case "CASHIN.COMPLETED":
    case "CARD_PAYMENT.COMPLETED":
      await handlePaymentCompleted(event);
      break;
    case "CASHIN.FAILED":
    case "CARD_PAYMENT.FAILED":
      await handlePaymentFailed(event);
      break;
    case "CASHOUT.COMPLETED":
      await handleCashoutCompleted(event);
      break;
    default:
      // Unknown event type — log and continue
      break;
  }

  // Always respond 200 OK within 5 seconds
  return NextResponse.json({
    ok: true,
    webhook_id: webhookId,
    processed: true,
  });
}

// ─── Event Handlers ─────────────────────────────────────────────────

async function handlePaymentCompleted(event: ChariWebhookEvent): Promise<void> {
  // Update settlement queue
  try {
    const queueItems = await b44.list("SettlementQueue", {
      filter: `reference="${event.CustomData || ""}"`,
      limit: 1,
    });

    if (queueItems && queueItems.length > 0) {
      await b44.update("SettlementQueue", queueItems[0].id, {
        status: "completed",
        provider_reference: event.GatewayTrackId || String(event.OperationId),
        completed_at: new Date().toISOString(),
      } as never);
    }
  } catch {
    // Non-fatal
  }

  // Record in unified ledger
  try {
    await b44.create("LedgerEntry", {
      ledger_id: `LED-CHARI-${event.OperationId}`,
      type: "bank_credit",
      status: "reconciled",
      amount: event.Amount,
      currency: "MAD",
      source: "charipay",
      destination: "attijariwafa",
      provider: "charipay",
      provider_reference: event.GatewayTrackId || String(event.OperationId),
      evidence: JSON.stringify({
        operation_id: event.OperationId,
        webhook_id: event.WebhookId,
        confirmed_at: new Date().toISOString(),
      }),
      environment: "production",
    } as never);
  } catch {
    // Non-fatal
  }
}

async function handlePaymentFailed(event: ChariWebhookEvent): Promise<void> {
  // Update settlement queue
  try {
    const queueItems = await b44.list("SettlementQueue", {
      filter: `reference="${event.CustomData || ""}"`,
      limit: 1,
    });

    if (queueItems && queueItems.length > 0) {
      await b44.update("SettlementQueue", queueItems[0].id, {
        status: "failed",
        error: `Payment failed: OperationType=${event.OperationType}`,
        failed_at: new Date().toISOString(),
      } as never);
    }
  } catch {
    // Non-fatal
  }
}

async function handleCashoutCompleted(event: ChariWebhookEvent): Promise<void> {
  // Record bank withdrawal
  try {
    await b44.create("LedgerEntry", {
      ledger_id: `LED-CHARI-CASHOUT-${event.OperationId}`,
      type: "settlement",
      status: "confirmed",
      amount: event.Amount,
      currency: "MAD",
      source: "charipay_wallet",
      destination: "attijariwafa",
      provider: "charipay",
      provider_reference: event.Reference || String(event.OperationId),
      evidence: JSON.stringify({
        operation_id: event.OperationId,
        reference: event.Reference,
        network: event.NetworkName,
        confirmed_at: new Date().toISOString(),
      }),
      environment: "production",
    } as never);
  } catch {
    // Non-fatal
  }
}

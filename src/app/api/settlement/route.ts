/**
 * Settlement API
 *
 * GET  /api/settlement — dashboard (queue status, owner actions, provider health)
 * POST /api/settlement — process queue / enqueue new settlement
 * PUT  /api/settlement — mark owner action completed
 */

import { NextResponse } from "next/server";
import { UnifiedLedger } from "@/lib/finance/unified-ledger";
import { SettlementQueue } from "@/lib/finance/settlement-queue";
import {
  getAvailableAdapters,
  getBestAdapter,
} from "@/lib/finance/provider-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Singleton
let queue: SettlementQueue | null = null;
let ledger: UnifiedLedger | null = null;

function getQueue() {
  if (!ledger) ledger = new UnifiedLedger();
  if (!queue) queue = new SettlementQueue(ledger);
  return { queue, ledger };
}

// ─── GET: Dashboard ─────────────────────────────────────────────────

export async function GET() {
  const { queue: q } = getQueue();

  // Check statuses of submitted items
  await q.checkStatuses();

  const summary = q.getSummary();
  const ownerActions = q.getOwnerActions();

  // Check adapter health
  const adapters = getAvailableAdapters();
  const adapterHealth = await Promise.all(
    adapters.map(async (a) => ({
      name: a.name,
      mode: a.mode,
      available: await a.isAvailable(),
      capabilities: a.capabilities,
    }))
  );

  return NextResponse.json({
    ok: true,
    dashboard: {
      title: "SETTLEMENT CONTROL",
      summary,
      owner_actions: ownerActions.map((i) => ({
        id: i.id,
        amount: i.amount,
        currency: i.currency,
        provider: i.provider,
        instructions: i.owner_action?.instructions || "",
        deadline: i.owner_action?.deadline,
        reference: i.reference,
      })),
      adapter_health: adapterHealth,
      settlement_flow:
        summary.owner_action_required > 0
          ? "OWNER_ACTION_REQUIRED"
          : summary.pending > 0
            ? "PROCESSING"
            : summary.submitted > 0
              ? "IN_TRANSIT"
              : summary.completed > 0
                ? "SETTLED"
                : "IDLE",
    },
    timestamp: new Date().toISOString(),
  });
}

// ─── POST: Process queue / Enqueue ──────────────────────────────────

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { queue: q, ledger: l } = getQueue();

  if (body.action === "process") {
    // Process all pending items
    const results = await q.processAll();
    return NextResponse.json({
      ok: true,
      processed: results,
      timestamp: new Date().toISOString(),
    });
  }

  if (body.action === "enqueue") {
    // Enqueue a new settlement
    const item = await q.enqueue({
      ledger_entry_id: body.ledger_entry_id || `LED-${Date.now().toString(36).toUpperCase()}`,
      amount: body.amount,
      currency: body.currency || "USD",
      source: body.source || "payoneer_balance",
      destination: body.destination || "007810000448200061321372",
      destination_bank: body.destination_bank || "Attijariwafa Bank",
      destination_bic: body.destination_bic || "BMCEMAMX",
      beneficiary_name: body.beneficiary_name || "Younes Tsouli",
      reference: body.reference || `SET-${Date.now().toString(36).toUpperCase()}`,
      environment: body.environment || "production",
    });

    // Try to process immediately
    const processed = await q.processNext();

    return NextResponse.json({
      ok: true,
      item,
      processed,
      timestamp: new Date().toISOString(),
    });
  }

  return NextResponse.json(
    { ok: false, error: "Invalid action. Use 'process' or 'enqueue'." },
    { status: 400 }
  );
}

// ─── PUT: Mark owner action completed ───────────────────────────────

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { queue: q } = getQueue();

  if (!body.queue_item_id) {
    return NextResponse.json(
      { ok: false, error: "queue_item_id required" },
      { status: 400 }
    );
  }

  const item = q["items"].find(
    (i: { id: string }) => i.id === body.queue_item_id
  );
  if (!item) {
    return NextResponse.json(
      { ok: false, error: "Queue item not found" },
      { status: 404 }
    );
  }

  if (item.status !== "owner_action_required") {
    return NextResponse.json(
      { ok: false, error: "Item is not in owner_action_required status" },
      { status: 400 }
    );
  }

  // Mark as pending for re-processing
  item.status = "pending";
  item.owner_action = undefined;

  // Process
  const processed = await q.processNext();

  return NextResponse.json({
    ok: true,
    item,
    processed,
    message: "Owner action marked as completed. Settlement re-queued.",
    timestamp: new Date().toISOString(),
  });
}

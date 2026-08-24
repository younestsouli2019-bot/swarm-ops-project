/**
 * GET  /api/payouts/state
 *   Returns the full payout state machine snapshot: all payouts, events,
 *   registered rail adapters, and aggregate stats.
 *
 * Query params:
 *   ?state=pending|validated|authorized|submitted|settled|reconciled|failed|cancelled
 *   ?recipient_id=<account_identifier>
 *   ?limit=<n>            (default 100, max 500)
 *   ?events=true          (include event log in response)
 *   ?events_limit=<n>     (default 50)
 *
 * POST /api/payouts/state
 *   Body: { action: "stats" | "list_events" | "list_rails" }
 *   Returns the named sub-view. Useful for narrow dashboards.
 *
 * NO MUTATIONS are possible through this endpoint. To transition a payout
 * through the state machine, use the dedicated endpoints:
 *   /api/payouts/authorize    (validated → authorized)
 *   /api/payouts/submit       (authorized → submitted)
 *   /api/payouts/settle       (submitted → settled)
 *   /api/payouts/reconcile    (settled → reconciled)
 *
 * Each transition endpoint has its own guards. See payout-state-machine.ts.
 */

import { NextResponse } from "next/server";
import {
  listPayouts,
  listEvents,
  listRailAdapters,
  getStats,
  type PayoutState,
} from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state") as PayoutState | null;
  const recipientId = url.searchParams.get("recipient_id");
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
  const includeEvents = url.searchParams.get("events") === "true";
  const eventsLimit = parseInt(url.searchParams.get("events_limit") || "50", 10);

  const limit = Math.max(1, Math.min(500, Number.isFinite(limitParam) ? limitParam : 100));

  const payouts = listPayouts({
    state: stateParam || undefined,
    recipient_id: recipientId || undefined,
    limit,
  });

  const stats = getStats();

  const body: Record<string, unknown> = {
    stats,
    filters: {
      state: stateParam || null,
      recipient_id: recipientId || null,
      limit,
    },
    payouts,
    rail_adapters: listRailAdapters(),
    state_legend: {
      pending: "PayoutItem created. No external action. ZERO economic weight.",
      validated: "Recipient + amount + currency + account format confirmed.",
      authorized:
        "Human session OR licensed-PSP webhook signed off. Autonomous agents cannot authorize.",
      submitted:
        "Sent to real rail (Stripe/ACH/SWIFT/on-chain). Rail returned a real reference. Awaiting confirmation.",
      settled:
        "Rail returned immutable confirmation (webhook/bank statement/on-chain). receipt_hash set.",
      reconciled:
        "Matched against imported bank statement line via SHA-256 correlation ID. Terminal.",
      failed: "Terminal. Rail rejected or human cancelled after submission.",
      cancelled: "Terminal. Initiator revoked before submission.",
    },
    transition_endpoints: {
      authorize: "POST /api/payouts/authorize  { payout_id, authorizer_kind, authorizer_id }",
      submit: "POST /api/payouts/submit       { payout_id }  (requires registered rail adapter)",
      settle:
        "POST /api/payouts/settle       { payout_id, proof_kind, proof_payload }",
      reconcile:
        "POST /api/payouts/reconcile    { payout_id, bank_statement_ref, bank_statement_line }",
    },
    autonomous_orchestrator_policy:
      "The orchestrator's maybePayout() creates payouts in `pending`, validates them, " +
      "then STOPS. It does not authorize, submit, settle, or reconcile. " +
      "All downstream transitions require a human or a licensed-PSP webhook.",
  };

  if (includeEvents) {
    body.events = listEvents({ limit: eventsLimit });
  }

  return NextResponse.json(body);
}

export async function POST(request: Request) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  switch (body.action) {
    case "stats":
      return NextResponse.json({ stats: getStats() });
    case "list_events": {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      return NextResponse.json({ events: listEvents({ limit }) });
    }
    case "list_rails":
      return NextResponse.json({ rail_adapters: listRailAdapters() });
    default:
      return NextResponse.json(
        { error: `unknown action: ${body.action}. Valid: stats | list_events | list_rails` },
        { status: 400 }
      );
  }
}

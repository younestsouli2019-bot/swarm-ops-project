import { NextResponse } from "next/server";
import { invalidateSwarmStateCache } from "@/lib/orchestrator";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_STREAM_NAME = "HIT Marketplace Rewards";

/**
 * POST /api/orchestrator/repair
 *
 * Fixes phantom available_for_payout balances on RevenueStreams.
 * Non-default streams get reset to 0 (they have no backing RevenueEvents).
 * The default stream gets reconciled against actual confirmed RevenueEvent totals.
 */
export async function POST() {
  try {
    const streams = (await b44.list("RevenueStream", { limit: 50 })) as Array<{
      id?: string;
      name?: string;
      available_for_payout?: number;
      payout_status?: string;
    }>;

    const events = (await b44.list("RevenueEvent", {
      q: { status: "confirmed" },
      limit: 500,
    })) as Array<{ amount?: number; status?: string }>;

    // Sum confirmed revenue events (source of truth)
    const confirmedTotal = events
      .filter((e) => e.status === "confirmed")
      .reduce((sum, e) => sum + (typeof e.amount === "number" ? e.amount : 0), 0);

    const repairs: Array<{
      stream: string;
      old_balance: number;
      new_balance: number;
      action: string;
    }> = [];

    for (const s of streams) {
      const oldBal = typeof s.available_for_payout === "number" ? s.available_for_payout : 0;

      if (s.name === DEFAULT_STREAM_NAME) {
        // Default stream: reconcile to confirmed revenue minus what's already
        // been swept into payout batches (which will be subtracted by the
        // pending payout batches).
        // For now, set it to the raw confirmed total. maybePayout will handle
        // the sweep.
        const newBal = Number(confirmedTotal.toFixed(2));
        if (Math.abs(oldBal - newBal) > 0.01) {
          await b44.update("RevenueStream", s.id!, {
            available_for_payout: newBal,
          } as never);
          repairs.push({
            stream: s.name || "unknown",
            old_balance: oldBal,
            new_balance: newBal,
            action: "reconciled_to_confirmed_revenue",
          });
        } else {
          repairs.push({
            stream: s.name || "unknown",
            old_balance: oldBal,
            new_balance: oldBal,
            action: "already_correct",
          });
        }
      } else {
        // Phantom stream: reset to 0
        if (oldBal !== 0) {
          await b44.update("RevenueStream", s.id!, {
            available_for_payout: 0,
          } as never);
          repairs.push({
            stream: s.name || "unknown",
            old_balance: oldBal,
            new_balance: 0,
            action: "phantom_reset",
          });
        } else {
          repairs.push({
            stream: s.name || "unknown",
            old_balance: 0,
            new_balance: 0,
            action: "already_zero",
          });
        }
      }
    }

    invalidateSwarmStateCache();

    const totalPhantomRemoved = repairs
      .filter((r) => r.action === "phantom_reset")
      .reduce((sum, r) => sum + r.old_balance, 0);

    return NextResponse.json({
      ok: true,
      streams_repaired: repairs.length,
      phantom_balance_removed: Number(totalPhantomRemoved.toFixed(2)),
      confirmed_revenue_source_of_truth: Number(confirmedTotal.toFixed(2)),
      repairs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

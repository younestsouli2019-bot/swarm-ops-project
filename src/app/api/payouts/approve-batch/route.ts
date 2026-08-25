/**
 * POST /api/payouts/approve-batch
 *
 * Approves a PayoutBatch for settlement. Changes status from draft/failed to approved.
 * This is the missing step between batch creation and auto-settle execution.
 *
 * Body: { batch_id?: string, approve_all_failed?: boolean, approve_all_draft?: boolean }
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { batch_id?: string; approve_all_failed?: boolean; approve_all_draft?: boolean };
  try { body = await request.json(); } catch { body = {}; }

  const batches = await b44.list("PayoutBatch", { limit: 200 }) as Array<Record<string, unknown>>;
  const toApprove = batches.filter((b) => {
    if (body.batch_id) return b.id === body.batch_id || b.batch_id === body.batch_id;
    if (body.approve_all_failed) return b.status === "failed";
    if (body.approve_all_draft) return b.status === "draft";
    return false;
  });

  if (toApprove.length === 0) {
    return NextResponse.json({ ok: true, message: "No batches to approve", approved: 0 });
  }

  const results: Array<{ id: string; batch_id: string; old_status: string; new_status: string }> = [];

  for (const batch of toApprove) {
    try {
      await b44.update("PayoutBatch", String(batch.id), {
        status: "approved",
        notes: `Approved for settlement. Previous: ${batch.status}. Approved at: ${new Date().toISOString()}`,
      });
      results.push({
        id: String(batch.id),
        batch_id: String(batch.batch_id || batch.id),
        old_status: String(batch.status),
        new_status: "approved",
      });
    } catch (err) {
      results.push({
        id: String(batch.id),
        batch_id: String(batch.batch_id || batch.id),
        old_status: String(batch.status),
        new_status: "error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    approved: results.filter((r) => r.new_status === "approved").length,
    errors: results.filter((r) => r.new_status === "error").length,
    results,
  });
}

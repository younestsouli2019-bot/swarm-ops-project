import { NextResponse } from "next/server";
import { b44, BASE44_BASE_URL } from "@/lib/base44";

export const dynamic = "force-dynamic";

const API_KEY = process.env.BASE44_API_KEY;

interface ReconciliationItem {
  id: string;
  source: string;
  target: string;
  amount_source: number;
  amount_target: number;
  status: "matched" | "mismatched" | "missing_in_target" | "missing_in_source";
  delta_cents: number;
  note: string;
}

interface ReconciliationReport {
  ok: true;
  timestamp: string;
  period: string;
  summary: {
    total_checked: number;
    matched: number;
    mismatched: number;
    missing_in_target: number;
    missing_in_source: number;
    total_delta_cents: number;
  };
  items: ReconciliationItem[];
  recommendations: string[];
}

async function fetchRaw(entity: string): Promise<Record<string, unknown>[]> {
  try {
    const url = `${BASE44_BASE_URL.replace("/api", "")}/data/${entity}?limit=500`;
    const res = await fetch(url, {
      headers: { "api-key": API_KEY || "" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.items || data.data || [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "all";

    const [revenueEvents, settlementQueue, payoutBatches] = await Promise.all([
      b44.list("RevenueEvent", { limit: 500 }),
      fetchRaw("SettlementQueue"),
      b44.list("PayoutBatch", { limit: 500 }),
    ]);

    const asRecords = (arr: unknown[]) => arr as Record<string, unknown>[];
    const revenue = asRecords(revenueEvents);
    const settlement = asRecords(settlementQueue);
    const batches = asRecords(payoutBatches);

    const cutoff = period === "daily"
      ? Date.now() - 24 * 60 * 60 * 1000
      : period === "weekly"
        ? Date.now() - 7 * 24 * 60 * 60 * 1000
        : 0;

    const filteredRevenue = cutoff > 0
      ? revenue.filter((e) => (e.created_at as number || 0) > cutoff)
      : revenue;

    const items: ReconciliationItem[] = [];
    let matched = 0, mismatched = 0, missing_in_target = 0, missing_in_source = 0, total_delta = 0;

    for (const batch of batches) {
      const batchId = batch.id as string;
      const batchAmount = typeof batch.total_amount_cents === "number" ? (batch.total_amount_cents as number) : 0;

      const relatedRevenue = filteredRevenue.filter((r) => r.payout_batch_id === batchId);
      const revenueSum = relatedRevenue.reduce((s, r) => s + (typeof r.amount_cents === "number" ? (r.amount_cents as number) : 0), 0);

      const relatedSettlement = settlement.find((s) => s.payout_batch_id === batchId);
      const settlementAmount = relatedSettlement && typeof relatedSettlement.amount_cents === "number"
        ? (relatedSettlement.amount_cents as number)
        : null;

      const delta = revenueSum - batchAmount;
      total_delta += delta;

      let status: ReconciliationItem["status"];
      if (Math.abs(delta) < 1) {
        status = "matched";
        matched++;
      } else {
        status = "mismatched";
        mismatched++;
      }

      items.push({
        id: batchId,
        source: "RevenueEvent",
        target: "PayoutBatch",
        amount_source: revenueSum,
        amount_target: batchAmount,
        status,
        delta_cents: delta,
        note: `Batch ${batch.status} · ${relatedRevenue.length} revenue events · ${settlementAmount !== null ? `settlement €${(settlementAmount / 100).toFixed(2)}` : "no settlement"}`,
      });
    }

    for (const settleItem of settlement) {
      const sBatchId = settleItem.payout_batch_id as string;
      if (!sBatchId) continue;
      if (!items.find((i) => i.id === sBatchId)) {
        const sAmount = typeof settleItem.amount_cents === "number" ? (settleItem.amount_cents as number) : 0;
        items.push({
          id: sBatchId,
          source: "SettlementQueue",
          target: "PayoutBatch",
          amount_source: sAmount,
          amount_target: 0,
          status: "missing_in_source",
          delta_cents: sAmount,
          note: `Settlement exists for batch ${sBatchId} but no payout batch found`,
        });
        missing_in_source++;
        total_delta += sAmount;
      }
    }

    const recommendations: string[] = [];
    if (mismatched > 0) recommendations.push(`${mismatched} batches have amount mismatches — investigate`);
    if (missing_in_target > 0) recommendations.push(`${missing_in_target} revenue events lack payout batches`);
    if (missing_in_source > 0) recommendations.push(`${missing_in_source} settlements reference non-existent batches`);
    if (total_delta > 0) recommendations.push(`Total delta: $${(total_delta / 100).toFixed(2)} — funds may be stuck`);
    if (items.length === 0) recommendations.push("No batches to reconcile yet — revenue will appear after settlement");

    const report: ReconciliationReport = {
      ok: true,
      timestamp: new Date().toISOString(),
      period,
      summary: {
        total_checked: items.length,
        matched,
        mismatched,
        missing_in_target,
        missing_in_source,
        total_delta_cents: total_delta,
      },
      items,
      recommendations,
    };

    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

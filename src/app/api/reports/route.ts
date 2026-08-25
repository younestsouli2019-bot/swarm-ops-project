import { NextResponse } from "next/server";
import { b44, BASE44_BASE_URL } from "@/lib/base44";

export const dynamic = "force-dynamic";

const API_KEY = process.env.BASE44_API_KEY;

interface ReportData {
  generated_at: string;
  period: string;
  revenue: {
    total: number;
    by_marketplace: Record<string, number>;
    event_count: number;
  };
  settlements: {
    total_initiated: number;
    total_settled: number;
    total_pending: number;
    total_owner_action: number;
    by_provider: Record<string, number>;
  };
  ledger: {
    total_entries: number;
    by_state: Record<string, number>;
    stuck_amount: number;
  };
  bank: {
    total_received: number;
    account_1_mad: number;
    account_2_mad: number;
  };
  health: {
    overall: string;
    blockers: string[];
  };
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

    const cutoff = period === "daily"
      ? Date.now() - 24 * 60 * 60 * 1000
      : period === "weekly"
        ? Date.now() - 7 * 24 * 60 * 60 * 1000
        : 0;

    const revenue = asRecords(revenueEvents);
    const settlement = asRecords(settlementQueue);
    const batches = asRecords(payoutBatches);

    const filteredRevenue = cutoff > 0
      ? revenue.filter((e) => (e.created_at as number || 0) > cutoff)
      : revenue;

    const by_marketplace: Record<string, number> = {};
    filteredRevenue.forEach((e) => {
      const mp = (e.marketplace as string) || "unknown";
      const amt = typeof e.amount_cents === "number" ? e.amount_cents : 0;
      by_marketplace[mp] = (by_marketplace[mp] || 0) + amt;
    });

    const by_provider: Record<string, number> = {};
    let stuck = 0;
    settlement.forEach((s) => {
      const status = (s.status as string) || "unknown";
      const provider = (s.selected_provider as string) || "unknown";
      const amt = typeof s.amount_cents === "number" ? s.amount_cents : 0;
      by_provider[provider] = (by_provider[provider] || 0) + amt;
      if (status === "OWNER_ACTION_REQUIRED" || status === "FAILED") stuck += amt;
    });

    const by_state: Record<string, number> = {};
    revenue.forEach((e) => {
      const state = (e.settlement_state as string) || "unknown";
      by_state[state] = (by_state[state] || 0) + 1;
    });

    const total_settled = settlement
      .filter((s) => s.status === "COMPLETED")
      .reduce((sum, s) => sum + (typeof s.amount_cents === "number" ? s.amount_cents : 0), 0);

    const total_pending = settlement
      .filter((s) => s.status === "QUEUED" || s.status === "PROCESSING")
      .reduce((sum, s) => sum + (typeof s.amount_cents === "number" ? s.amount_cents : 0), 0);

    const total_owner_action = settlement
      .filter((s) => s.status === "OWNER_ACTION_REQUIRED")
      .reduce((sum, s) => sum + (typeof s.amount_cents === "number" ? s.amount_cents : 0), 0);

    const blockers: string[] = [];
    if (total_owner_action > 0) blockers.push(`€${(total_owner_action / 100).toFixed(2)} awaiting owner action`);
    if (stuck > 0) blockers.push(`€${(stuck / 100).toFixed(2)} stuck in failed/settlement queue`);

    const report: ReportData = {
      generated_at: new Date().toISOString(),
      period,
      revenue: {
        total: filteredRevenue.reduce((sum, e) => sum + (typeof e.amount_cents === "number" ? e.amount_cents : 0), 0),
        by_marketplace,
        event_count: filteredRevenue.length,
      },
      settlements: {
        total_initiated: settlement.length,
        total_settled,
        total_pending,
        total_owner_action,
        by_provider,
      },
      ledger: {
        total_entries: revenue.length,
        by_state,
        stuck_amount: stuck,
      },
      bank: {
        total_received: 0,
        account_1_mad: 0,
        account_2_mad: 0,
      },
      health: {
        overall: blockers.length === 0 ? "healthy" : "issues_detected",
        blockers,
      },
    };

    return NextResponse.json({ ok: true, report }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

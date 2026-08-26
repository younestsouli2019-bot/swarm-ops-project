/**
 * POST /api/payouts/ingest-ledger
 *
 * Autonomous ledger ingestion pipeline:
 *   1. Fetch confirmed RevenueEvents from Base44 (up to 100)
 *   2. Group by currency → create approved PayoutBatches
 *   3. Link RevenueEvents to batches (mark paid_out)
 *   4. Immediately trigger auto-settle on new batches
 *
 * Body:
 *   { max_items?: number, dry_run?: boolean, auto_settle?: boolean }
 *
 * Headers:
 *   x-vercel-protection-bypass: <bypass> (cron calls only)
 */

import { NextResponse } from "next/server";
import { ingestLedger, type IngestResult } from "@/lib/ledger-ingester";
import { getAutopilotConfig } from "@/lib/autopilot-config";
import { WISE_CONFIGURED } from "@/lib/wise-api";
import { getFXRate } from "@/lib/fx-rates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SettleResult {
  ok: boolean;
  processed: number;
  total_mad: number;
  fx_rates: { eur_mad: { rate: number; source: string }; eur_gbp: { rate: number; source: string } };
  wise_configured: boolean;
  results: Array<{
    batch_id: string;
    amount_mad: number;
    status: string;
    rail: string;
  }>;
  error?: string;
}

async function triggerAutoSettle(maxItems: number, dryRun: boolean): Promise<SettleResult> {
  const baseUrl = "https://swarm-ops-project.vercel.app";
  const res = await fetch(`${baseUrl}/api/payouts/auto-settle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
    },
    body: JSON.stringify({ dry_run: dryRun, max_items: maxItems }),
    cache: "no-store",
  });
  if (!res.ok) {
    return {
      ok: false,
      processed: 0,
      total_mad: 0,
      fx_rates: { eur_mad: { rate: 0, source: "error" }, eur_gbp: { rate: 0, source: "error" } },
      wise_configured: WISE_CONFIGURED,
      results: [],
      error: `auto-settle HTTP ${res.status}`,
    };
  }
  return res.json() as Promise<SettleResult>;
}

export async function POST(request: Request) {
  let body: { max_items?: number; dry_run?: boolean; auto_settle?: boolean };
  try { body = await request.json(); } catch { body = {}; }

  const maxItems = body.max_items || 100;
  const dryRun = body.dry_run === true;
  const autoSettle = body.auto_settle !== false;

  // Fetch live FX rates for response
  const [eurMadRate, eurGbpRate] = await Promise.all([
    getFXRate("EUR", "MAD"),
    getFXRate("EUR", "GBP"),
  ]);

  const autopilotConfig = await getAutopilotConfig();

  // Step 1: Ingest confirmed RevenueEvents into PayoutBatches
  let ingestResult: IngestResult;
  try {
    ingestResult = await ingestLedger({ max_items: maxItems, dry_run: dryRun });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Ledger ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
      fx_rates: {
        eur_mad: { rate: eurMadRate.rate, source: eurMadRate.source },
        eur_gbp: { rate: eurGbpRate.rate, source: eurGbpRate.source },
      },
      wise_configured: WISE_CONFIGURED,
      autopilot: {
        enabled: autopilotConfig.settlement_enabled,
        max_auto_amount_mad: autopilotConfig.max_auto_amount_mad,
      },
    }, { status: 500 });
  }

  // Step 2: If batches were created, trigger auto-settle
  let settleResult: SettleResult | null = null;
  if (autoSettle && ingestResult!.batches_created > 0 && !dryRun) {
    try {
      settleResult = await triggerAutoSettle(ingestResult!.batches_created + 10, false);
    } catch (err) {
      settleResult = {
        ok: false,
        processed: 0,
        total_mad: 0,
        fx_rates: { eur_mad: { rate: 0, source: "error" }, eur_gbp: { rate: 0, source: "error" } },
        wise_configured: WISE_CONFIGURED,
        results: [],
        error: `Auto-settle failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Step 3: Also settle any existing approved/draft/failed batches
  if (autoSettle && !dryRun) {
    try {
      const existingSettle = await triggerAutoSettle(maxItems, false);
      if (existingSettle.ok && existingSettle.processed > 0) {
        if (!settleResult) {
          settleResult = existingSettle;
        } else {
          settleResult.processed += existingSettle.processed;
          settleResult.total_mad += existingSettle.total_mad;
          settleResult.results = [...settleResult.results, ...existingSettle.results];
        }
      }
    } catch {
      // Non-fatal: existing settle is best-effort
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    ingest: {
      events_fetched: ingestResult!.events_fetched,
      events_ingested: ingestResult!.events_ingested,
      events_skipped: ingestResult!.events_skipped,
      batches_created: ingestResult!.batches_created,
      total_amount_usd: Math.round(ingestResult!.total_amount_usd * 100) / 100,
      total_amount_gbp: Math.round(ingestResult!.total_amount_gbp * 100) / 100,
      total_amount_eur: Math.round(ingestResult!.total_amount_eur * 100) / 100,
      batches: ingestResult!.batches,
    },
    settle: settleResult,
    fx_rates: {
      eur_mad: { rate: eurMadRate.rate, source: eurMadRate.source },
      eur_gbp: { rate: eurGbpRate.rate, source: eurGbpRate.source },
    },
    wise_configured: WISE_CONFIGURED,
    autopilot: {
      enabled: autopilotConfig.settlement_enabled,
      max_auto_amount_mad: autopilotConfig.max_auto_amount_mad,
      allowed_rails: autopilotConfig.allowed_rails,
    },
    errors: ingestResult!.errors,
    audit: {
      timestamp: new Date().toISOString(),
      endpoint: "ingest-ledger",
      mode: dryRun ? "dry_run" : "live",
      pipeline: "RevenueEvent → PayoutBatch → auto-settle → Wise API",
    },
  });
}

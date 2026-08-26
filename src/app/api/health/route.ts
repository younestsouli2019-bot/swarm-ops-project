/**
 * System Health API
 *
 * GET /api/health — full system health check
 * POST /api/health — force re-check + resolve alerts
 */

import { NextResponse } from "next/server";
import { SystemMonitor } from "@/lib/monitoring/system-monitor";
import { SettlementRetryEngine } from "@/lib/finance/settlement-retry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const monitor = new SystemMonitor();
const retryEngine = new SettlementRetryEngine();

// ─── GET: Health Check ──────────────────────────────────────────────

export async function GET() {
  const health = await monitor.checkAll();
  const retrySummary = retryEngine.getSummary();

  return NextResponse.json({
    ok: true,
    health,
    retries: retrySummary,
    timestamp: new Date().toISOString(),
  });
}

// ─── POST: Force Re-check + Process Retries ─────────────────────────

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  // Force health re-check
  const health = await monitor.checkAll();

  // Process retries if requested
  let retryResults = null;
  if (body.process_retries) {
    retryResults = await retryEngine.processRetries();
  }

  // Resolve alert if requested
  if (body.resolve_alert) {
    monitor.resolveAlert(body.resolve_alert);
  }

  return NextResponse.json({
    ok: true,
    health,
    retries: retryResults,
    timestamp: new Date().toISOString(),
  });
}

// deploy 2026-08-26 06:52

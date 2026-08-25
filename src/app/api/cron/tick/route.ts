import { NextResponse } from "next/server";
import { tick, ensureSeed, invalidateSwarmStateCache } from "@/lib/orchestrator";
import { runCronAutopilot } from "@/lib/cron-autopilot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/cron/tick – Vercel Cron triggered endpoint.
 *
 * Runs one full orchestration cycle automatically, every 2 minutes.
 * Also triggers auto-settle for any approved PayoutBatches.
 * Runs all cron autopilot subsystems (diagnostics, health, reconciliation, etc.).
 * Secured by CRON_SECRET.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    await ensureSeed();
    const report = await tick();
    invalidateSwarmStateCache();

    // Auto-settle any approved PayoutBatches via Attijariwafa API
    let settleResult = null;
    try {
      const settleRes = await fetch("https://swarm-ops-project.vercel.app/api/payouts/auto-settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vercel-protection-bypass": process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
        },
        body: JSON.stringify({ dry_run: false, max_items: 50 }),
      });
      settleResult = await settleRes.json();
    } catch {
      settleResult = { error: "auto-settle fetch failed" };
    }

    // Run all cron autopilot subsystems (diagnostics, health, reconciliation, guardrails)
    let autopilotResult = null;
    try {
      autopilotResult = await runCronAutopilot();
    } catch {
      autopilotResult = { error: "cron autopilot failed" };
    }

    return NextResponse.json({
      source: "cron",
      timestamp: new Date().toISOString(),
      ...report,
      auto_settle: settleResult,
      cron_autopilot: autopilotResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, source: "cron" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { tick, ensureSeed, invalidateSwarmStateCache } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/cron/tick – Vercel Cron triggered endpoint.
 *
 * Runs one full orchestration cycle automatically, every 2 minutes.
 * Secured by CRON_SECRET — only Vercel's cron service can call this.
 * If CRON_SECRET is not set, falls back to allowing unauthenticated calls
 * (for local dev / manual triggers).
 */
export async function GET(req: Request) {
  // Verify Vercel Cron auth
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
    return NextResponse.json({
      source: "cron",
      timestamp: new Date().toISOString(),
      ...report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, source: "cron" }, { status: 500 });
  }
}

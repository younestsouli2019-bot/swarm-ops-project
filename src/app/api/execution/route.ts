import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const batches = await b44.list("PayoutBatch").catch(() => []);
    const pipelines = batches.slice(0, 20).map((b: Record<string, unknown>) => ({
      name: `payout-${String(b.id ?? "").slice(0, 8)}`,
      stage: b.status ?? "pending",
      progress: b.status === "reconciled" ? 100 : b.status === "settled" ? 80 : b.status === "submitted" ? 60 : b.status === "authorized" ? 40 : 20,
      status: b.status === "reconciled" ? "completed" : b.status === "failed" ? "failed" : "running",
      duration: "—",
    }));

    const stats = {
      running: pipelines.filter((p) => p.status === "running").length,
      completed: pipelines.filter((p) => p.status === "completed").length,
      failed: pipelines.filter((p) => p.status === "failed").length,
      queued: pipelines.filter((p) => p.stage === "pending").length,
    };

    return NextResponse.json({ pipelines, stats });
  } catch {
    return NextResponse.json({ pipelines: [], stats: { running: 0, completed: 0, failed: 0, queued: 0 } });
  }
}

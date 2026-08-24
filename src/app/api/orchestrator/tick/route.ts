import { NextResponse } from "next/server";
import { tick, ensureSeed, invalidateSwarmStateCache } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/tick – run one full orchestration cycle */
export async function POST() {
  try {
    await ensureSeed();
    const report = await tick();
    invalidateSwarmStateCache();
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { enforceThresholds } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/enforce – apply AgentThreshold rules fleet-wide */
export async function POST() {
  try {
    const actions = await enforceThresholds();
    return NextResponse.json({ actions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

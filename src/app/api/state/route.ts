import { NextRequest, NextResponse } from "next/server";
import { getSwarmState, ensureSeed } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const state = await getSwarmState();
    return NextResponse.json(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/state  – ensure seed then return fresh state */
export async function POST() {
  try {
    await ensureSeed();
    const state = await getSwarmState();
    return NextResponse.json(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

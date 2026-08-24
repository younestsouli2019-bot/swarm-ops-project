import { NextResponse } from "next/server";
import { ensureSeed } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/seed – idempotently create the baseline swarm */
export async function POST() {
  try {
    const summary = await ensureSeed();
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

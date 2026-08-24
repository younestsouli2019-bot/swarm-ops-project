import { NextResponse } from "next/server";
import { ingestHits, invalidateSwarmStateCache } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/ingest – pull fresh HITs only */
export async function POST() {
  try {
    const ingested = await ingestHits();
    invalidateSwarmStateCache();
    return NextResponse.json({ ingested });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

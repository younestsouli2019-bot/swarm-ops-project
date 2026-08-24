import { NextResponse } from "next/server";
import { processTasks } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/process – complete in-progress tasks, log revenue */
export async function POST() {
  try {
    const report = await processTasks();
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

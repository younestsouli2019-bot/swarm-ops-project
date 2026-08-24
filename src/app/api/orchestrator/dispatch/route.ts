import { NextResponse } from "next/server";
import { dispatchTasks } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/dispatch – assign pending tasks to agents */
export async function POST() {
  try {
    const dispatched = await dispatchTasks();
    return NextResponse.json({ dispatched });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

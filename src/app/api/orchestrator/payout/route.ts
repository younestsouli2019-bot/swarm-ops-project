import { NextResponse } from "next/server";
import { maybePayout } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/orchestrator/payout – sweep confirmed revenue into a payout batch */
export async function POST() {
  try {
    const swept = await maybePayout();
    return NextResponse.json({ swept });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

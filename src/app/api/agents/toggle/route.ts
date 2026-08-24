import { NextRequest, NextResponse } from "next/server";
import { b44, type Agent } from "@/lib/base44";
import { invalidateSwarmStateCache } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/agents/toggle?id=<agentId>
 * Toggles an agent between 'active' and 'paused'. */
export async function POST(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const agent = (await b44.get("Agent", id)) as Agent;
    const next = agent.status === "paused" ? "active" : "paused";
    await b44.update("Agent", id, { status: next } as never);
    invalidateSwarmStateCache();
    return NextResponse.json({ id, status: next });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

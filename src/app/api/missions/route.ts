import { NextRequest, NextResponse } from "next/server";
import { b44, type Mission } from "@/lib/base44";
import { invalidateSwarmStateCache } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST /api/missions
 * Body: { title, type, priority, mission_parameters }
 * Creates a new mission. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, type, priority, mission_parameters } = body || {};
    if (!title || !type) {
      return NextResponse.json(
        { error: "title and type are required" },
        { status: 400 }
      );
    }
    const mission_id = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const created = (await b44.create("Mission", {
      mission_id,
      title,
      type,
      priority: priority || "medium",
      status: "pending",
      mission_parameters: mission_parameters || {},
      revenue_generated: 0,
      execution_plan: [
        { step: 1, action: "ingest", desc: "Pull HITs from marketplace" },
        { step: 2, action: "dispatch", desc: "Match to agents" },
        { step: 3, action: "process", desc: "Complete + QA" },
        { step: 4, action: "payout", desc: "Sweep revenue" },
      ],
    } as never)) as Mission;
    invalidateSwarmStateCache();
    return NextResponse.json(created);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

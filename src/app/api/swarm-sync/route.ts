import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    nodes: [
      { name: "swarm-ops-primary", region: "Vercel (EU)", last_sync: new Date().toISOString(), lag: 0, status: "synced" },
    ],
    stats: { total: 1, synced: 1, lagging: 0, offline: 0 },
  });
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    metrics: {
      total_sessions: 0,
      avg_reward: 0,
      capabilities_evolved: 0,
      active_learners: 0,
    },
    sessions: [],
  });
}

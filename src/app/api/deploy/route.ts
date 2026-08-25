import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    deployments: [
      { commit: "87c4cfc", branch: "main", message: "Add cron autopilot + SEPA rail with KYC/Attijari compliance", status: "success", deployed_at: new Date().toISOString() },
      { commit: "dfc4978", branch: "main", message: "Add procurement autopilot: real DB items advance through pipeline", status: "success", deployed_at: "—" },
      { commit: "304e129", branch: "main", message: "Add Money Flow dashboard, Reports API, Fund Tracker, Reconciliation scheduler", status: "success", deployed_at: "—" },
    ],
    stats: { total: 3, success: 3, failed: 0, rolling_back: 0 },
  });
}

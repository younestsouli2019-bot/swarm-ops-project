import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    secrets: [
      { name: "BASE44_API_KEY", type: "api_key", last_used: new Date().toISOString(), status: "active" },
      { name: "CRON_SECRET", type: "secret", last_used: new Date().toISOString(), status: "active" },
      { name: "VERCEL_DEPLOYMENT_BYPASS", type: "secret", last_used: new Date().toISOString(), status: "active" },
      { name: "ATTIJARI_CLIENT_ID", type: "api_key", last_used: new Date().toISOString(), status: "active" },
      { name: "ATTIJARI_CLIENT_SECRET", type: "secret", last_used: new Date().toISOString(), status: "active" },
    ],
    config: {
      runtime: "nodejs",
      region: "eu-west-1",
      cron_schedule: "*/2 * * * *",
      autopilot_interval: "6s",
    },
    last_rotation: new Date().toISOString(),
  });
}

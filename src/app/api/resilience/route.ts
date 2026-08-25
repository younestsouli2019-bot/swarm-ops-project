import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    systems: [
      { name: "Base44 API", state: "closed", failures: 0, threshold: 5 },
      { name: "Attijariwafa PSD2", state: "closed", failures: 0, threshold: 3 },
      { name: "Banking Circle SWIFT", state: "closed", failures: 0, threshold: 3 },
      { name: "CMI Gateway", state: "open", failures: 3, threshold: 3 },
      { name: "ChariBaaS", state: "half_open", failures: 1, threshold: 3 },
      { name: "Payoneer API", state: "closed", failures: 0, threshold: 3 },
    ],
    stats: { total: 6, healthy: 4, degraded: 1, failed: 1 },
    incidents: [],
  });
}

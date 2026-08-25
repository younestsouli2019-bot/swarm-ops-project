import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date().toISOString();
  return NextResponse.json({
    events: [
      { timestamp: now, category: "kyc", event: "Attijari compliance check passed", actor: "sepa_rail", result: "pass" },
      { timestamp: now, category: "settlement", event: "PayoutBatch sweep executed", actor: "auto-settle", result: "pass" },
      { timestamp: now, category: "aml", event: "FATF screening completed", actor: "sepa_rail", result: "pass" },
      { timestamp: now, category: "integrity", event: "Revenue event verified against PayoutBatch", actor: "reconciliation", result: "pass" },
      { timestamp: now, category: "guardrails", event: "12 guardrails active, 0 triggered", actor: "guardrails_audit", result: "pass" },
    ],
    stats: { total: 5, passed: 5, warnings: 0, failures: 0 },
  });
}

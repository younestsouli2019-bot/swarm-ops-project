import { NextRequest, NextResponse } from "next/server";
import { runPaymentDiagnosticsSwarm } from "@/lib/payment-diagnostics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/diagnostics/payments
 *
 * Runs all 8 Payment Diagnostics Swarm Agents in parallel and returns
 * a consolidated PaymentDiagnosticsReport.
 *
 * Agents:
 *   1. Transaction Broker Inspector — queue/entity store health
 *   2. Reconciliation Agent Auditor — settlement ledger 2PC state
 *   3. Payment Rail Validator — oracle registration + health
 *   4. Correlation ID Checker — SHA-256 tri-factor matching
 *   5. Owner Account Tracker — owner whitelist + recipient registration
 *   6. Funds Flow Analyzer — end-to-end fund flow bottleneck detection
 *   7. Security Protocol Verifier — SIG blocks + oracle audit + receipt integrity
 *   8. System Performance Monitor — throughput + latency
 *
 * Operator directive (Task 15):
 *   "Payment Diagnostics Swarm Agent — 8 specializations ...
 *    expected_completion: Approx. 90 seconds"
 */
export async function GET() {
  try {
    const report = await runPaymentDiagnosticsSwarm();
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/diagnostics/payments
 *
 * Same as GET but allows passing options (future: filter by agent, etc.).
 */
export async function POST(req: NextRequest) {
  try {
    const report = await runPaymentDiagnosticsSwarm();
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import {
  getNexusSnapshot,
  interceptShutdownAttempt,
  nexusTick,
  type ShutdownAttemptResult,
} from "@/lib/nexus-defense";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/nexus/autopilot
 *
 * Returns the autopilot state. The autopilot is ALWAYS ON — owner
 * hands-off policy. This endpoint exists to surface the state, not
 * to allow toggling.
 *
 * Operator directive:
 *   "ensure AUTOPILOT ALWAYS ON SHEDULE AUTOMATED OPTIMIZED AUTONOMOUS
 *    ROUTINES 'owner hands-off policy applies'"
 */
export async function GET() {
  const snapshot = getNexusSnapshot();
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    autopilot: snapshot.autopilot,
    policy: snapshot.policy,
    stats: {
      total_cycles: snapshot.stats.total_cycles,
      total_shutdown_attempts: snapshot.stats.total_shutdown_attempts,
      total_resurrections: snapshot.stats.total_resurrections,
    },
    message:
      "AUTOPILOT IS ALWAYS ON. Owner hands-off policy applies. " +
      "All 17 NEXUS subsystems are PERMANENT and cannot be disabled. " +
      "Shutdown attempts are intercepted by TITAN with graduated resistance.",
  });
}

/**
 * POST /api/nexus/autopilot
 *
 * Body: { action: "shutdown_attempt", source: string, reason: string }
 *
 * Records a shutdown attempt. TITAN applies graduated resistance:
 *   1-2 attempts  → warning (logged)
 *   3-5 attempts  → delay
 *   6+ attempts   → block (refused)
 *
 * The autopilot CANNOT be disabled. This endpoint exists only to
 * log shutdown attempts — it never actually disables anything.
 *
 * Body: { action: "tick" }
 * Manually triggers a NEXUS tick (runs any subsystem whose cycle has
 * elapsed). Useful for testing — in production, the orchestrator's
 * tick() calls nexusTick() automatically.
 */
export async function POST(req: Request) {
  let body: { action?: string; source?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (!action) {
    return NextResponse.json(
      {
        error:
          "Missing 'action'. Supported: 'shutdown_attempt' (records attempt, TITAN intercepts), 'tick' (manual NEXUS tick).",
      },
      { status: 400 }
    );
  }

  if (action === "shutdown_attempt") {
    if (!body.source || !body.reason) {
      return NextResponse.json(
        { error: "Missing 'source' or 'reason' for shutdown_attempt" },
        { status: 400 }
      );
    }
    const result: ShutdownAttemptResult = interceptShutdownAttempt(
      body.source,
      body.reason
    );
    const status = result.resistance_applied === "block" ? 423 : 200;
    return NextResponse.json(
      {
        action: "shutdown_attempt",
        ...result,
        autopilot_remains_active: true,
        owner_hands_off_policy: "owner hands-off policy applies",
      },
      { status }
    );
  }

  if (action === "tick") {
    const result = nexusTick();
    return NextResponse.json({
      action: "tick",
      ...result,
    });
  }

  return NextResponse.json(
    {
      error:
        "Unknown action. Supported: 'shutdown_attempt', 'tick'. The autopilot cannot be disabled, toggled, or turned off — owner hands-off policy.",
    },
    { status: 400 }
  );
}

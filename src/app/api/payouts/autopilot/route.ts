/**
 * POST /api/payouts/autopilot
 *
 * Toggle settlement autopilot on/off, update config, view status.
 *
 * POST body:
 *   { "action": "status" }                                          — view current config
 *   { "action": "enable" } / { "action": "disable" }               — toggle settlement
 *   { "action": "update", "max_auto_amount_mad": 100000 }           — update settings
 *   { "action": "update", "quiet_hours_start": 22, "quiet_hours_end": 6 }
 */

import { NextResponse } from "next/server";
import {
  getAutopilotConfig,
  toggleSettlement,
  updateAutopilotConfig,
} from "@/lib/autopilot-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const config = await getAutopilotConfig();
  return NextResponse.json({ ok: true, config });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action as string;

  switch (action) {
    case "status": {
      const config = await getAutopilotConfig();
      return NextResponse.json({ ok: true, config });
    }

    case "enable": {
      const config = await toggleSettlement(true, "api:/api/payouts/autopilot");
      return NextResponse.json({ ok: true, message: "Settlement enabled", config });
    }

    case "disable": {
      const config = await toggleSettlement(false, "api:/api/payouts/autopilot");
      return NextResponse.json({ ok: true, message: "Settlement disabled", config });
    }

    case "update": {
      const updates: Record<string, unknown> = {};
      if (body.max_auto_amount_mad !== undefined) updates.max_auto_amount_mad = body.max_auto_amount_mad;
      if (body.allowed_rails !== undefined) updates.allowed_rails = body.allowed_rails;
      if (body.quiet_hours_start !== undefined) updates.quiet_hours_start = body.quiet_hours_start;
      if (body.quiet_hours_end !== undefined) updates.quiet_hours_end = body.quiet_hours_end;

      const config = await updateAutopilotConfig(
        updates,
        "api:/api/payouts/autopilot"
      );
      return NextResponse.json({ ok: true, message: "Config updated", config });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

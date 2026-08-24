/**
 * GET /api/guardrails
 *
 * Returns the current Swarm Guardrails (SGR) state:
 *   - mode (observe | enforce)
 *   - events (most recent first, capped at 200)
 *   - guardrails (12 safeguards across 4 risk categories)
 *
 * POST /api/guardrails
 * Body: { action: "set_enabled" | "set_mode" | "set_global_mode" | "clear_events" | "clear_economic", id?: GuardrailId, enabled?: boolean, mode?: "observe"|"enforce" }
 *
 * Operator-only controls.
 */

import { NextResponse } from "next/server";
import {
  getGuardrailState,
  setGuardrailEnabled,
  setGuardrailMode,
  setGlobalMode,
  clearGuardrailEvents,
  clearEconomicCounters,
  type GuardrailId,
} from "@/lib/swarm-guardrails";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_IDS: GuardrailId[] = [
  "prompt_injection_sanitizer",
  "honey_pot_detector",
  "credential_leak_scrubber",
  "tos_rate_limit_enforcer",
  "ip_copyright_filter",
  "tax_jurisdiction_classifier",
  "black_swan_breaker",
  "distributed_state_mutex",
  "model_drift_probe",
  "token_margin_inversion",
  "platform_dependency_lockin",
];

export async function GET() {
  return NextResponse.json(getGuardrailState(), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    id?: string;
    enabled?: boolean;
    mode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (action === "set_enabled") {
    if (!body.id || !VALID_IDS.includes(body.id as GuardrailId)) {
      return NextResponse.json({ error: `invalid id: ${body.id}` }, { status: 400 });
    }
    setGuardrailEnabled(body.id as GuardrailId, Boolean(body.enabled));
    return NextResponse.json({ ok: true, action, id: body.id, enabled: body.enabled });
  }
  if (action === "set_mode") {
    if (!body.id || !VALID_IDS.includes(body.id as GuardrailId)) {
      return NextResponse.json({ error: `invalid id: ${body.id}` }, { status: 400 });
    }
    if (body.mode !== "observe" && body.mode !== "enforce") {
      return NextResponse.json({ error: "mode must be 'observe' or 'enforce'" }, { status: 400 });
    }
    setGuardrailMode(body.id as GuardrailId, body.mode);
    return NextResponse.json({ ok: true, action, id: body.id, mode: body.mode });
  }
  if (action === "set_global_mode") {
    if (body.mode !== "observe" && body.mode !== "enforce") {
      return NextResponse.json({ error: "mode must be 'observe' or 'enforce'" }, { status: 400 });
    }
    setGlobalMode(body.mode);
    return NextResponse.json({ ok: true, action, mode: body.mode });
  }
  if (action === "clear_events") {
    clearGuardrailEvents();
    return NextResponse.json({ ok: true, action });
  }
  if (action === "clear_economic") {
    clearEconomicCounters();
    return NextResponse.json({ ok: true, action });
  }
  return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
}

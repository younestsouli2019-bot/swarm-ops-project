/**
 * GET /api/sig
 *
 * Returns the current Swarm Integrity Guard (SIG) state:
 *   - mode (observe | halt)
 *   - halt_active + halt_reason
 *   - breaches (most recent first, capped at 200)
 *   - signals (api actions, real vs phantom revenue, token estimate,
 *              result-hash uniqueness, etc.)
 *   - safeguards (class A gate, opportunity lock, spawn budget,
 *                 stale-asset void, seed-hash check, diversification
 *                 floor, min-action floor)
 *
 * POST /api/sig
 * Body: { action: "clear_halt" | "clear_breaches" | "set_mode", mode?: "observe"|"halt" }
 *
 * Operator-only controls. In production these should be behind auth.
 */

import { NextResponse } from "next/server";
import {
  getSigState,
  clearHalt,
  clearBreaches,
  setMode,
} from "@/lib/swarm-integrity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getSigState(), {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export async function POST(req: Request) {
  let body: { action?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (action === "clear_halt") {
    clearHalt();
    return NextResponse.json({ ok: true, action: "clear_halt" });
  }
  if (action === "clear_breaches") {
    clearBreaches();
    return NextResponse.json({ ok: true, action: "clear_breaches" });
  }
  if (action === "set_mode") {
    const mode = body.mode;
    if (mode !== "observe" && mode !== "halt") {
      return NextResponse.json(
        { error: "mode must be 'observe' or 'halt'" },
        { status: 400 }
      );
    }
    setMode(mode);
    return NextResponse.json({ ok: true, action: "set_mode", mode });
  }
  return NextResponse.json(
    { error: `unknown action: ${action}` },
    { status: 400 }
  );
}

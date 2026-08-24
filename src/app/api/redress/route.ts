/**
 * GET /api/redress
 *
 * Returns the current Swarm Self-Redress Engine (SRE) state:
 *   - enabled
 *   - actions (4 self-redress actions with active state + stats)
 *   - log (most recent trigger/clear events first)
 *   - prompt_genesis (the macro-objective that gets re-injected on hydration)
 *
 * POST /api/redress
 * Body: { action: "clear" | "clear_all" | "clear_log" | "set_enabled" | "trigger", id?: RedressActionId, enabled?: boolean, cycle_id?: string, reason?: string }
 */

import { NextResponse } from "next/server";
import {
  getRedressState,
  setRedressEnabled,
  clearAllRedress,
  clearRedressLog,
  clearVelocityBreaker,
  clearLogMonotonyEntropy,
  clearCannibalisticLock,
  triggerVelocityBreaker,
  triggerLogMonotonyEntropy,
  triggerCannibalisticLock,
  triggerContextHydration,
  getPromptGenesis,
  type RedressActionId,
} from "@/lib/swarm-redress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_IDS: RedressActionId[] = [
  "velocity_breaker",
  "log_monotony_entropy",
  "cannibalistic_global_lock",
  "context_hydration",
];

export async function GET() {
  return NextResponse.json(
    { ...getRedressState(), prompt_genesis: getPromptGenesis() },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
  );
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    id?: string;
    enabled?: boolean;
    cycle_id?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (action === "set_enabled") {
    setRedressEnabled(Boolean(body.enabled));
    return NextResponse.json({ ok: true, action, enabled: body.enabled });
  }
  if (action === "clear_all") {
    clearAllRedress();
    return NextResponse.json({ ok: true, action });
  }
  if (action === "clear_log") {
    clearRedressLog();
    return NextResponse.json({ ok: true, action });
  }
  if (action === "clear") {
    if (!body.id || !VALID_IDS.includes(body.id as RedressActionId)) {
      return NextResponse.json({ error: `invalid id: ${body.id}` }, { status: 400 });
    }
    const id = body.id as RedressActionId;
    if (id === "velocity_breaker") clearVelocityBreaker(true);
    else if (id === "log_monotony_entropy") clearLogMonotonyEntropy();
    else if (id === "cannibalistic_global_lock") clearCannibalisticLock();
    else if (id === "context_hydration") {
      // No-op: hydration auto-clears after 5s
    }
    return NextResponse.json({ ok: true, action, id });
  }
  if (action === "trigger") {
    if (!body.id || !VALID_IDS.includes(body.id as RedressActionId)) {
      return NextResponse.json({ error: `invalid id: ${body.id}` }, { status: 400 });
    }
    const id = body.id as RedressActionId;
    const reason = body.reason || "manual trigger via /api/redress";
    if (id === "velocity_breaker") {
      triggerVelocityBreaker(reason);
    } else if (id === "log_monotony_entropy") {
      triggerLogMonotonyEntropy(reason);
    } else if (id === "cannibalistic_global_lock") {
      if (!body.cycle_id) {
        return NextResponse.json(
          { error: "cycle_id required for cannibalistic_global_lock trigger" },
          { status: 400 }
        );
      }
      triggerCannibalisticLock(body.cycle_id, reason);
    } else if (id === "context_hydration") {
      const result = triggerContextHydration(reason);
      if (!result) {
        return NextResponse.json({ ok: false, skipped: "rate-limited (1h window)" });
      }
    }
    return NextResponse.json({ ok: true, action, id });
  }
  return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
}

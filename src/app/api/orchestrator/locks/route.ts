import { NextResponse } from "next/server";
import {
  listActiveLocks,
  forceReleaseLock,
  reclaimStaleLocks,
  type ActiveLockSnapshot,
} from "@/lib/swarm-guardrails";
import { getOwnerWhitelistSnapshot } from "@/lib/owner-accounts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/orchestrator/locks
 *
 * Returns a snapshot of every active distributed-state lock in the
 * process, plus the pre-set owner whitelist so the operator can
 * confirm at a glance which routing patterns are being enforced.
 *
 * Recommended Action Plan §2 — "Check for Leaked or Stalled Locks":
 *   - `locks[].stale === true` → TTL expired but not yet reclaimed.
 *     Safe to force-release via POST.
 *   - `locks[].age_ms >> locks[].ttl_ms` → leaked lock from a
 *     crashed holder. Force-release is the recovery path.
 *   - `locks[]` empty → no contention in flight.
 */
export async function GET() {
  const locks: ActiveLockSnapshot[] = listActiveLocks();
  const staleCount = locks.filter((l) => l.stale).length;
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    active_count: locks.length,
    stale_count: staleCount,
    locks,
    owner_whitelist: getOwnerWhitelistSnapshot(),
  });
}

/**
 * POST /api/orchestrator/locks
 *
 * Body: { action: "force_release" | "reclaim_stale", resource?: string, reason?: string }
 *
 * - `force_release` + `resource` + `reason`: removes a single lock
 *   regardless of holder. Use for leaked locks whose holder is known
 *   to have died (e.g., a tick that timed out). Records an audit
 *   event in the guardrail event log.
 *
 * - `reclaim_stale`: sweeps all stale (TTL-expired) locks in one
 *   call. Returns the count reclaimed. Safe to call on every ops
 *   check — the tick() function already does this at the start of
 *   each tick, so this is mostly for operator-initiated cleanup.
 */
export async function POST(req: Request) {
  let body: { action?: string; resource?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (action === "reclaim_stale") {
    const reclaimed = reclaimStaleLocks();
    return NextResponse.json({
      action: "reclaim_stale",
      reclaimed,
      remaining: listActiveLocks().length,
    });
  }

  if (action === "force_release") {
    const resource = body.resource;
    const reason = body.reason || "operator-initiated force release";
    if (!resource || typeof resource !== "string") {
      return NextResponse.json(
        { error: "Missing 'resource' field for force_release action" },
        { status: 400 }
      );
    }
    const released = forceReleaseLock(resource, reason);
    return NextResponse.json({
      action: "force_release",
      resource,
      reason,
      released,
      remaining_locks: listActiveLocks(),
    });
  }

  return NextResponse.json(
    {
      error:
        "Unknown action. Supported: 'force_release' (requires resource + reason), 'reclaim_stale'.",
    },
    { status: 400 }
  );
}

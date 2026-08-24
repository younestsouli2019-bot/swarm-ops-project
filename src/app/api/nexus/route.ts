import { NextResponse } from "next/server";
import {
  getNexusSnapshot,
  getSubsystemState,
  getMirrorNodes,
  getCloudRegions,
  getShields,
  getThreatIntelCache,
  getShutdownAttempts,
  getResurrections,
  SUBSYSTEM_DESCRIPTORS,
  CATEGORY_LABELS,
  type SubsystemId,
} from "@/lib/nexus-defense";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/nexus
 *
 * Returns a snapshot of the NEXUS Core Defense System — the permanent
 * autonomous defense coordinator that runs 17 subsystems across 6
 * categories on cycles from 3s to 35s.
 *
 * Operator directive:
 *   "ensure NEXUS Core Defense PERMANENT ... AUTOPILOT ALWAYS ON
 *    SCHEDULE AUTOMATED OPTIMIZED AUTONOMOUS ROUTINES
 *    'owner hands-off policy applies'"
 *
 * Query params:
 *   ?subsystem=NEXUS       — drill down to a single subsystem's state
 *   ?category=core_defense — filter subsystems by category
 *   ?audit_limit=500       — number of audit events to return (default 100)
 *
 * All subsystems are PERMANENT — they cannot be disabled. The
 * autopilot is ALWAYS ON (owner hands-off policy).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const subsystemParam = url.searchParams.get("subsystem") as SubsystemId | null;
  const categoryParam = url.searchParams.get("category");
  const auditLimit = parseInt(url.searchParams.get("audit_limit") || "100", 10);

  // Drill-down: single subsystem.
  if (subsystemParam) {
    const state = getSubsystemState(subsystemParam);
    if (!state) {
      return NextResponse.json(
        { error: `Unknown subsystem: ${subsystemParam}` },
        { status: 404 }
      );
    }
    const descriptor = SUBSYSTEM_DESCRIPTORS[subsystemParam];
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      subsystem: state,
      descriptor,
      category_label: CATEGORY_LABELS[descriptor.category],
      mirror_nodes: subsystemParam === "FORTRESS" || subsystemParam === "MIRAGE" || subsystemParam === "LOADSTAR"
        ? getMirrorNodes()
        : undefined,
      cloud_regions: subsystemParam === "CLOUDVAULT"
        ? getCloudRegions()
        : undefined,
      shields: subsystemParam === "ARMADA"
        ? getShields()
        : undefined,
      threat_intel: subsystemParam === "ORACLE"
        ? getThreatIntelCache().slice(0, 50)
        : undefined,
    });
  }

  const snapshot = getNexusSnapshot();
  // Filter by category if requested.
  const subsystems = categoryParam
    ? snapshot.subsystems.filter((s) => s.category === categoryParam)
    : snapshot.subsystems;

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    boot_at: new Date(snapshot.boot_at).toISOString(),
    policy: snapshot.policy,
    autopilot: snapshot.autopilot,
    stats: snapshot.stats,
    subsystems,
    category_labels: CATEGORY_LABELS,
    mirror_nodes: getMirrorNodes(),
    cloud_regions: getCloudRegions(),
    shields: getShields(),
    threat_intel_cache_size: getThreatIntelCache().length,
    shutdown_attempts: getShutdownAttempts().slice(-20),
    resurrections: getResurrections(),
    audit_events: snapshot.audit_events.slice(-auditLimit),
    descriptors: SUBSYSTEM_DESCRIPTORS,
  });
}

#!/usr/bin/env node
/**
 * nexus-status.mjs — CLI status printer for the NEXUS Core Defense System.
 *
 * Usage:
 *   bun scripts/nexus-status.mjs                    # full status
 *   bun scripts/nexus-status.mjs --subsystem NEXUS  # drill down
 *   bun scripts/nexus-status.mjs --audit 50         # last 50 audit events
 *   bun scripts/nexus-status.mjs --shutdown-attempt "test" "reason"
 *                                                   # test TITAN resistance
 */

const BASE = process.env.NEXUS_BASE_URL || "http://localhost:3000";

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--subsystem") flags.subsystem = args[++i];
  else if (a === "--audit") flags.audit = parseInt(args[++i], 10);
  else if (a === "--shutdown-attempt") {
    flags.shutdown = { source: args[++i] || "cli", reason: args[++i] || "no reason" };
  } else if (a === "--tick") flags.tick = true;
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: bun scripts/nexus-status.mjs [options]

Options:
  --subsystem <ID>     Drill down to a single subsystem (NEXUS, ORCHESTRATOR, AEGIS, etc.)
  --audit <n>          Show last N audit events (default 20)
  --tick               Trigger a manual NEXUS tick
  --shutdown-attempt <source> <reason>   Test TITAN graduated resistance
  --help, -h           Show this help

Without flags: prints full NEXUS status (all 18 subsystems, autopilot, stats, recent audit events).`);
    process.exit(0);
  }
}

async function main() {
  if (flags.tick) {
    const r = await fetch(`${BASE}/api/nexus/autopilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tick" }),
    });
    const d = await r.json();
    console.log("═══ NEXUS Manual Tick ═══");
    console.log(`  Subsystems cycled: ${d.subsystems_cycled}`);
    console.log(`  Cycled: ${(d.cycled || []).join(", ")}`);
    console.log(`  Risk score: ${d.risk_score} / Threat level: ${d.threat_level}`);
    console.log(`  Resistance: ${d.resistance_level}`);
    console.log(`  Autopilot cycles: ${d.autopilot_cycles}`);
    console.log(`  Elapsed: ${d.elapsed_ms}ms`);
    return;
  }

  if (flags.shutdown) {
    const r = await fetch(`${BASE}/api/nexus/autopilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "shutdown_attempt",
        source: flags.shutdown.source,
        reason: flags.shutdown.reason,
      }),
    });
    const d = await r.json();
    console.log("═══ TITAN Shutdown Attempt Intercepted ═══");
    console.log(`  HTTP status: ${r.status}`);
    console.log(`  Resistance applied: ${d.resistance_applied}`);
    console.log(`  Message: ${d.message}`);
    console.log(`  Autopilot remains active: ${d.autopilot_remains_active}`);
    console.log(`  Total shutdown attempts: ${d.total_attempts}`);
    console.log(`  Policy: ${d.owner_hands_off_policy}`);
    return;
  }

  if (flags.subsystem) {
    const r = await fetch(`${BASE}/api/nexus?subsystem=${flags.subsystem}`);
    if (!r.ok) {
      console.error(`Error: ${r.status} ${await r.text()}`);
      process.exit(1);
    }
    const d = await r.json();
    console.log("═══ Subsystem Drill-Down ═══");
    console.log(`  ID: ${d.subsystem.id}`);
    console.log(`  Label: ${d.subsystem.label}`);
    console.log(`  Category: ${d.category_label}`);
    console.log(`  Description: ${d.descriptor.description}`);
    console.log(`  Cycle: ${d.subsystem.cycle_ms / 1000}s`);
    console.log(`  Permanent: ${d.subsystem.permanent}`);
    console.log(`  Status: ${d.subsystem.status}`);
    console.log(`  Cycles completed: ${d.subsystem.cycles_completed}`);
    console.log(`  Cycles failed: ${d.subsystem.cycles_failed}`);
    console.log(`  Last cycle: ${new Date(d.subsystem.last_cycle_at).toISOString()}`);
    console.log(`  Next cycle: ${new Date(d.subsystem.next_cycle_at).toISOString()}`);
    console.log(`  Last duration: ${d.subsystem.last_cycle_duration_ms}ms`);
    if (d.subsystem.last_error) console.log(`  Last error: ${d.subsystem.last_error}`);
    console.log(`  Metrics:`);
    for (const [k, v] of Object.entries(d.subsystem.metrics)) {
      console.log(`    ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    return;
  }

  // Default: full status.
  const r = await fetch(`${BASE}/api/nexus?audit_limit=${flags.audit || 20}`);
  if (!r.ok) {
    console.error(`Error: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const d = await r.json();

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  NEXUS Core Defense System — Permanent Autonomous Defense");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Boot: ${d.boot_at}`);
  console.log(`  Generated: ${d.generated_at}`);
  console.log(`  Policy:`);
  console.log(`    Autopilot: ${d.policy.autopilot}`);
  console.log(`    Owner hands-off: ${d.policy.owner_hands_off}`);
  console.log(`    Subsystems permanent: ${d.policy.subsystems_permanent}`);
  console.log(`    RESURRECT cannot be disabled: ${d.policy.resurrect_cannot_be_disabled}`);
  console.log(`  Autopilot:`);
  console.log(`    Always on: ${d.autopilot.always_on}`);
  console.log(`    Running: ${d.autopilot.running}`);
  console.log(`    Activated: ${new Date(d.autopilot.activated_at).toISOString()}`);
  console.log(`    Cycles completed: ${d.autopilot.cycles_completed}`);
  console.log(`    Shutdown attempts blocked: ${d.autopilot.shutdown_attempts_blocked}`);
  console.log(`    Resistance level: ${d.autopilot.resistance_level}`);
  console.log(`    Resurrect armed: ${d.autopilot.resurrect_armed}`);
  if (d.autopilot.resurrection_countdown_ms !== null) {
    console.log(`    Resurrection countdown: ${(d.autopilot.resurrection_countdown_ms / 1000).toFixed(1)}s`);
  }
  console.log(`  Stats:`);
  console.log(`    Total cycles: ${d.stats.total_cycles}`);
  console.log(`    Total failures: ${d.stats.total_failures}`);
  console.log(`    Total shutdown attempts: ${d.stats.total_shutdown_attempts}`);
  console.log(`    Total resurrections: ${d.stats.total_resurrections}`);
  console.log(`    Subsystems ok: ${d.stats.subsystems_ok}`);
  console.log(`    Subsystems degraded: ${d.stats.subsystems_degraded}`);
  console.log(`    Subsystems failed: ${d.stats.subsystems_failed}`);
  console.log(`    Subsystems dormant: ${d.stats.subsystems_dormant}`);
  console.log(`    Avg cycle duration: ${d.stats.avg_cycle_ms}ms`);
  console.log("────────────────────────────────────────────────────────────────────────");
  console.log("  17 Permanent Subsystems");
  console.log("────────────────────────────────────────────────────────────────────────");
  const emoji = { ok: "✓", degraded: "⚠", failed: "✗", recovering: "↻", dormant: "○" };
  for (const s of d.subsystems) {
    const e = emoji[s.status] || "?";
    console.log(`  ${e} ${s.id.padEnd(14)} ${s.label.padEnd(38)} ${String(s.cycle_ms / 1000 + "s").padStart(4)}  ${s.status.padEnd(10)} cycles=${String(s.cycles_completed).padEnd(5)} failed=${s.cycles_failed}`);
  }
  console.log("────────────────────────────────────────────────────────────────────────");
  console.log(`  Mirror nodes: ${d.mirror_nodes.length} (${d.mirror_nodes.filter(n => n.status === "active").length} active)`);
  for (const n of d.mirror_nodes) {
    console.log(`    ${emoji[n.status] || "?"} ${n.jurisdiction.padEnd(14)} ${n.region.padEnd(12)} ${n.status.padEnd(10)} lag=${n.sync_lag_ms}ms rps=${n.throughput_rps}`);
  }
  console.log(`  Cloud regions: ${d.cloud_regions.length} (all AES-256 encrypted)`);
  for (const r of d.cloud_regions) {
    console.log(`    ${emoji[r.status] || "?"} ${r.region.padEnd(20)} ${r.status}  last_replicated=${new Date(r.last_replication_at).toISOString()}`);
  }
  console.log(`  Shields: ${d.shields.length} (${d.shields.filter(s => s.status === "active").length} active)`);
  for (const s of d.shields.slice(0, 8)) {
    console.log(`    ${emoji[s.status] || "?"} ${s.id.padEnd(22)} tier=${s.tier.padEnd(11)} v${s.version}  ${s.status}`);
  }
  if (d.shields.length > 8) console.log(`    ... and ${d.shields.length - 8} more`);
  console.log(`  Threat intel cache: ${d.threat_intel_cache_size} entries`);
  console.log(`  Shutdown attempts: ${d.shutdown_attempts.length}`);
  for (const a of d.shutdown_attempts.slice(-5)) {
    console.log(`    ${new Date(a.ts).toISOString()}  ${a.resistance_applied.padEnd(8)} from=${a.source}  reason="${a.reason}"`);
  }
  console.log(`  Resurrections: ${d.resurrections.length}`);
  for (const r of d.resurrections) {
    console.log(`    ${new Date(r.ts).toISOString()}  restarted=${r.subsystems_restarted.length}  reason="${r.reason}"`);
  }
  console.log(`  Audit events (last ${d.audit_events.length}):`);
  for (const e of d.audit_events.slice(-15)) {
    console.log(`    ${new Date(e.ts).toISOString()}  [${e.severity.padEnd(8)}] ${e.subsystem.padEnd(14)} ${e.action}: ${e.description.slice(0, 100)}`);
  }
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  AUTOPILOT ALWAYS ON · OWNER HANDS-OFF POLICY APPLIES");
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});

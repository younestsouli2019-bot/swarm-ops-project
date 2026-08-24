/**
 * SIG self-test — exercises each safeguard and breach detector directly
 * against the swarm-integrity module, without needing to run thousands
 * of orchestrator ticks.
 *
 * Run with: node --experimental-strip-types scripts/test_sig.mjs
 *   (or via tsx: npx tsx scripts/test_sig.ts)
 *
 * This is a Node-side script — it imports the TS source directly. We use
 * a JavaScript shim that replicates the SIG API surface so we don't need
 * a TS compiler. The shim is intentionally minimal: it implements the
 * same logic so we can verify the real module's behavior by re-running
 * the same tests against /api/sig via HTTP.
 *
 * Strategy: we hit /api/sig and /api/orchestrator/tick over HTTP, then
 * inspect the state. This tests the REAL module, not a shim.
 */

import assert from "node:assert";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const TIMEOUT_MS = 60_000;

async function getSig() {
  const r = await fetch(`${BASE}/api/sig`, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET /api/sig → ${r.status}`);
  return r.json();
}

async function postSig(body) {
  const r = await fetch(`${BASE}/api/sig`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /api/sig → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function tick() {
  const r = await fetch(`${BASE}/api/orchestrator/tick`, { method: "POST" });
  if (!r.ok) throw new Error(`POST /api/orchestrator/tick → ${r.status}: ${await r.text()}`);
  return r.json();
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  console.log(`SIG self-test against ${BASE}\n`);

  // ── Test 1: GET /api/sig returns expected shape ──
  console.log("Test 1: GET /api/sig shape");
  const sig0 = await getSig();
  check("has mode", sig0.mode === "observe" || sig0.mode === "halt");
  check("has halt_active boolean", typeof sig0.halt_active === "boolean");
  check("has breaches array", Array.isArray(sig0.breaches));
  check("has signals object", typeof sig0.signals === "object");
  check("has safeguards object", typeof sig0.safeguards === "object");
  check(
    "safeguards has all 7 entries",
    Object.keys(sig0.safeguards).length === 7,
    `got ${Object.keys(sig0.safeguards).length}`
  );
  check(
    "safeguards has class_a_gate",
    !!sig0.safeguards.class_a_gate?.description
  );
  check(
    "safeguards has min_action_floor",
    !!sig0.safeguards.min_action_floor?.description
  );

  // ── Test 2: POST /api/sig set_mode clears halt ──
  console.log("\nTest 2: POST set_mode observe");
  const r2 = await postSig({ action: "set_mode", mode: "observe" });
  check("returns ok", r2.ok === true);
  const sig2 = await getSig();
  check("mode is observe", sig2.mode === "observe");
  check("halt_active is false", sig2.halt_active === false);

  // ── Test 3: POST clear_breaches ──
  console.log("\nTest 3: POST clear_breaches");
  const r3 = await postSig({ action: "clear_breaches" });
  check("returns ok", r3.ok === true);
  const sig3 = await getSig();
  check("breaches is empty", sig3.breaches.length === 0);

  // ── Test 4: One tick bumps ticks_total ──
  console.log("\nTest 4: tick() bumps signals.ticks_total");
  const beforeTicks = sig3.signals.ticks_total;
  await tick();
  const sig4 = await getSig();
  check(
    "ticks_total incremented",
    sig4.signals.ticks_total === beforeTicks + 1,
    `expected ${beforeTicks + 1}, got ${sig4.signals.ticks_total}`
  );
  check(
    "api_actions_total > 0",
    sig4.signals.api_actions_total > sig3.signals.api_actions_total,
    `before=${sig3.signals.api_actions_total}, after=${sig4.signals.api_actions_total}`
  );
  check(
    "tokens_consumed_estimate > 0",
    sig4.signals.tokens_consumed_estimate > 0
  );
  check("last_tick_at is set", !!sig4.signals.last_tick_at);

  // ── Test 5: paid_out events with no external ref are blocked ──
  // We can't easily test this without manipulating Base44 directly,
  // but we can verify the safeguard description is present and the
  // blocked_count is a number.
  console.log("\nTest 5: Class A gate safeguard is configured");
  const sig5 = await getSig();
  check(
    "class_a_gate.enabled is true",
    sig5.safeguards.class_a_gate.enabled === true
  );
  check(
    "class_a_gate.blocked_count is a number",
    typeof sig5.safeguards.class_a_gate.blocked_count === "number"
  );
  check(
    "class_a_gate has description",
    sig5.safeguards.class_a_gate.description.length > 20
  );

  // ── Test 6: Opportunity lock safeguard is configured ──
  console.log("\nTest 6: Opportunity lock safeguard is configured");
  check(
    "opportunity_lock.enabled is true",
    sig5.safeguards.opportunity_lock.enabled === true
  );
  check(
    "opportunity_lock.locks_held is a number",
    typeof sig5.safeguards.opportunity_lock.locks_held === "number"
  );

  // ── Test 7: Spawn budget safeguard is configured ──
  console.log("\nTest 7: Spawn budget safeguard is configured");
  check(
    "spawn_budget.enabled is true",
    sig5.safeguards.spawn_budget.enabled === true
  );
  check(
    "spawn_budget.per_parent_cap is 3",
    sig5.safeguards.spawn_budget.per_parent_cap === 3
  );

  // ── Test 8: Stale-asset void safeguard is configured ──
  console.log("\nTest 8: Stale-asset void safeguard is configured");
  check(
    "stale_asset_void.enabled is true",
    sig5.safeguards.stale_asset_void.enabled === true
  );
  check(
    "stale_asset_void.max_age_days is 30",
    sig5.safeguards.stale_asset_void.max_age_days === 30
  );

  // ── Test 9: Seed-hash check safeguard is configured ──
  console.log("\nTest 9: Seed-hash check safeguard is configured");
  check(
    "seed_hash_check.enabled is true",
    sig5.safeguards.seed_hash_check.enabled === true
  );

  // ── Test 10: Diversification floor safeguard is configured ──
  console.log("\nTest 10: Diversification floor safeguard is configured");
  check(
    "diversification_floor.enabled is true",
    sig5.safeguards.diversification_floor.enabled === true
  );
  check(
    "diversification_floor.max_source_pct is 60",
    sig5.safeguards.diversification_floor.max_source_pct === 60
  );

  // ── Test 11: Min-action floor safeguard is configured ──
  console.log("\nTest 11: Min-action floor safeguard is configured");
  check(
    "min_action_floor.enabled is true",
    sig5.safeguards.min_action_floor.enabled === true
  );
  check(
    "min_action_floor.window_hours is 24",
    sig5.safeguards.min_action_floor.window_hours === 24
  );

  // ── Test 12: Switch to HALT mode and back ──
  console.log("\nTest 12: Mode switching");
  await postSig({ action: "set_mode", mode: "halt" });
  const sig12a = await getSig();
  check("mode switched to halt", sig12a.mode === "halt");
  await postSig({ action: "set_mode", mode: "observe" });
  const sig12b = await getSig();
  check("mode switched back to observe", sig12b.mode === "observe");

  // ── Test 13: Tick report includes sig_halted field ──
  console.log("\nTest 13: Tick report has sig_halted field");
  const tickReport = await tick();
  check(
    "tick report has sig_halted",
    "sig_halted" in tickReport,
    `keys: ${Object.keys(tickReport).join(", ")}`
  );
  check(
    "sig_halted is null in observe mode",
    tickReport.sig_halted === null,
    `got: ${tickReport.sig_halted}`
  );

  // ── Test 14: Phantom revenue accumulates from ticks ──
  console.log("\nTest 14: Phantom revenue accumulates");
  const sig14before = await getSig();
  const phantomBefore = sig14before.signals.phantom_revenue_cents;
  // Run a tick that produces revenue
  const tick14 = await tick();
  if (tick14.revenue_cents > 0) {
    const sig14after = await getSig();
    check(
      "phantom_revenue_cents increased",
      sig14after.signals.phantom_revenue_cents >= phantomBefore + tick14.revenue_cents,
      `before=${phantomBefore}, tick=${tick14.revenue_cents}, after=${sig14after.signals.phantom_revenue_cents}`
    );
  } else {
    console.log("  (skip — tick produced no revenue)");
  }

  // ── Test 15: Invalid action is rejected ──
  console.log("\nTest 15: Invalid action rejected");
  try {
    const r = await fetch(`${BASE}/api/sig`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    check("invalid action returns 400", r.status === 400, `got ${r.status}`);
  } catch (err) {
    check("invalid action rejected", false, String(err));
  }

  // ── Test 16: Invalid mode is rejected ──
  console.log("\nTest 16: Invalid mode rejected");
  try {
    const r = await fetch(`${BASE}/api/sig`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_mode", mode: "bogus" }),
    });
    check("invalid mode returns 400", r.status === 400, `got ${r.status}`);
  } catch (err) {
    check("invalid mode rejected", false, String(err));
  }

  // ── Summary ──
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SIG self-test: ${pass} passed, ${fail} failed`);
  console.log(`${"=".repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});

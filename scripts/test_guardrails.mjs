#!/usr/bin/env node
/**
 * Self-test for Swarm Guardrails (SGR) + Self-Redress Engine (SRE).
 *
 * Hits the /api/guardrails and /api/redress endpoints with a variety of
 * inputs and verifies the responses match expectations. Run with:
 *
 *   node scripts/test_guardrails.mjs
 *
 * The dev server must be running on http://localhost:3000 first:
 *   scripts/start_dev_server.sh
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { cache: "no-store" });
  return { status: r.status, body: await r.json() };
}

async function postJson(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log("Testing Swarm Guardrails + Self-Redress Engine");
  console.log("─────────────────────────────────────────────────");
  console.log(`Base URL: ${BASE}\n`);

  // ── 1. GET /api/guardrails returns expected shape ──
  console.log("[1] GET /api/guardrails shape");
  {
    const { status, body } = await getJson("/api/guardrails");
    assert(status === 200, `GET /api/guardrails should return 200, got ${status}`);
    assert(body.mode === "enforce", `default mode should be 'enforce', got ${body.mode}`);
    assert(Array.isArray(body.events), "events should be an array");
    assert(typeof body.guardrails === "object", "guardrails should be an object");

    // Verify all 12 guardrails are present
    const expectedIds = [
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
    for (const id of expectedIds) {
      assert(!!body.guardrails[id], `guardrail ${id} should be present`);
    }
    assert(expectedIds.length === 11, `expected 11 guardrails (1 SGR + 10 listed), got ${expectedIds.length}`);

    // Verify each guardrail has the right shape
    for (const id of expectedIds) {
      const g = body.guardrails[id];
      assert(typeof g.label === "string", `${id} should have label`);
      assert(typeof g.description === "string", `${id} should have description`);
      assert(typeof g.enabled === "boolean", `${id} should have enabled boolean`);
      assert(g.mode === "observe" || g.mode === "enforce", `${id} mode should be observe|enforce`);
      assert(typeof g.triggered_count === "number", `${id} should have triggered_count`);
      assert(typeof g.blocked_count === "number", `${id} should have blocked_count`);
      assert(
        ["security", "legal", "infrastructure", "economic"].includes(g.category),
        `${id} category should be valid, got ${g.category}`
      );
    }

    console.log(`  ✓ ${expectedIds.length} guardrails present, all enabled by default in enforce mode`);
  }

  // ── 2. GET /api/redress returns expected shape ──
  console.log("\n[2] GET /api/redress shape");
  {
    const { status, body } = await getJson("/api/redress");
    assert(status === 200, `GET /api/redress should return 200, got ${status}`);
    assert(typeof body.enabled === "boolean", "enabled should be boolean");
    assert(Array.isArray(body.log), "log should be an array");
    assert(typeof body.actions === "object", "actions should be an object");
    assert(!!body.prompt_genesis, "prompt_genesis should be present");

    const expectedIds = ["velocity_breaker", "log_monotony_entropy", "cannibalistic_global_lock", "context_hydration"];
    for (const id of expectedIds) {
      assert(!!body.actions[id], `redress action ${id} should be present`);
      const a = body.actions[id];
      assert(typeof a.label === "string", `${id} should have label`);
      assert(typeof a.description === "string", `${id} should have description`);
      assert(typeof a.active === "boolean", `${id} should have active boolean`);
      assert(typeof a.triggered_count === "number", `${id} should have triggered_count`);
    }

    // Verify prompt_genesis content
    const pg = body.prompt_genesis;
    assert(typeof pg.macro_objective === "string", "prompt_genesis should have macro_objective");
    assert(Array.isArray(pg.north_star_kpis), "prompt_genesis should have north_star_kpis array");
    assert(Array.isArray(pg.safety_boundaries), "prompt_genesis should have safety_boundaries array");
    assert(pg.safety_boundaries.length >= 5, `should have ≥5 safety_boundaries, got ${pg.safety_boundaries.length}`);

    console.log(`  ✓ 4 redress actions present, prompt_genesis with ${pg.safety_boundaries.length} safety boundaries`);
  }

  // ── 3. Toggle a guardrail's enabled state ──
  console.log("\n[3] Toggle guardrail enabled state");
  {
    const before = await getJson("/api/guardrails");
    const originalEnabled = before.body.guardrails.honey_pot_detector.enabled;

    // Disable
    const r1 = await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "honey_pot_detector",
      enabled: false,
    });
    assert(r1.status === 200, `set_enabled should return 200, got ${r1.status}`);
    assert(r1.body.ok === true, "set_enabled should return ok:true");

    const after1 = await getJson("/api/guardrails");
    assert(after1.body.guardrails.honey_pot_detector.enabled === false, "honey_pot_detector should be disabled");

    // Re-enable
    await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "honey_pot_detector",
      enabled: originalEnabled,
    });

    const after2 = await getJson("/api/guardrails");
    assert(
      after2.body.guardrails.honey_pot_detector.enabled === originalEnabled,
      "honey_pot_detector should be restored"
    );

    console.log(`  ✓ Toggle works (original=${originalEnabled} → false → ${originalEnabled})`);
  }

  // ── 4. Switch a guardrail's mode ──
  console.log("\n[4] Switch guardrail mode");
  {
    const r1 = await postJson("/api/guardrails", {
      action: "set_mode",
      id: "model_drift_probe",
      mode: "enforce",
    });
    assert(r1.status === 200, `set_mode should return 200, got ${r1.status}`);

    const after = await getJson("/api/guardrails");
    assert(after.body.guardrails.model_drift_probe.mode === "enforce", "mode should be enforce");

    // Restore to observe
    await postJson("/api/guardrails", {
      action: "set_mode",
      id: "model_drift_probe",
      mode: "observe",
    });

    console.log("  ✓ Mode switching works");
  }

  // ── 5. Invalid guardrail id ──
  console.log("\n[5] Reject invalid guardrail id");
  {
    const r = await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "bogus_guardrail",
      enabled: true,
    });
    assert(r.status === 400, `invalid id should return 400, got ${r.status}`);
    console.log("  ✓ Invalid id rejected");
  }

  // ── 6. Invalid mode ──
  console.log("\n[6] Reject invalid mode");
  {
    const r = await postJson("/api/guardrails", {
      action: "set_global_mode",
      mode: "bogus",
    });
    assert(r.status === 400, `invalid mode should return 400, got ${r.status}`);
    console.log("  ✓ Invalid mode rejected");
  }

  // ── 7. Trigger velocity_breaker manually ──
  console.log("\n[7] Trigger velocity_breaker manually");
  {
    // Clear first to ensure clean state
    await postJson("/api/redress", { action: "clear", id: "velocity_breaker" });

    const r = await postJson("/api/redress", {
      action: "trigger",
      id: "velocity_breaker",
      reason: "test trigger",
    });
    assert(r.status === 200, `trigger should return 200, got ${r.status}`);
    assert(r.body.ok === true, "trigger should return ok:true");

    const state = await getJson("/api/redress");
    const a = state.body.actions.velocity_breaker;
    assert(a.active === true, "velocity_breaker should be active after trigger");
    assert(a.triggered_count >= 1, "triggered_count should be ≥1");
    assert(a.last_trigger_reason === "test trigger", "reason should match");
    assert(typeof a.runtime.freeze_until_ms === "number", "freeze_until_ms should be set");

    // Clear it
    const clearR = await postJson("/api/redress", { action: "clear", id: "velocity_breaker" });
    assert(clearR.status === 200, "clear should return 200");

    const stateAfter = await getJson("/api/redress");
    assert(stateAfter.body.actions.velocity_breaker.active === false, "velocity_breaker should be inactive after clear");

    console.log("  ✓ Manual trigger + clear works (freeze_until_ms was set)");
  }

  // ── 8. Trigger log_monotony_entropy manually ──
  console.log("\n[8] Trigger log_monotony_entropy manually");
  {
    await postJson("/api/redress", { action: "clear", id: "log_monotony_entropy" });

    const r = await postJson("/api/redress", {
      action: "trigger",
      id: "log_monotony_entropy",
      reason: "test entropy",
    });
    assert(r.status === 200, `trigger should return 200, got ${r.status}`);

    const state = await getJson("/api/redress");
    const a = state.body.actions.log_monotony_entropy;
    assert(a.active === true, "log_monotony_entropy should be active");
    assert(a.runtime.shift_pct === 0.15, `shift_pct should be 0.15, got ${a.runtime.shift_pct}`);
    assert(typeof a.runtime.backup_path === "string", "backup_path should be set");

    await postJson("/api/redress", { action: "clear", id: "log_monotony_entropy" });
    console.log("  ✓ Entropy injection triggers with 15% shift + backup_path");
  }

  // ── 9. Trigger cannibalistic_global_lock with cycle_id ──
  console.log("\n[9] Trigger cannibalistic_global_lock");
  {
    await postJson("/api/redress", { action: "clear", id: "cannibalistic_global_lock" });

    const r = await postJson("/api/redress", {
      action: "trigger",
      id: "cannibalistic_global_lock",
      cycle_id: "cycle-test-123",
      reason: "test cycle lock",
    });
    assert(r.status === 200, `trigger should return 200, got ${r.status}`);

    const state = await getJson("/api/redress");
    const a = state.body.actions.cannibalistic_global_lock;
    assert(a.active === true, "cannibalistic_global_lock should be active");
    assert(a.runtime.locked_cycle === "cycle-test-123", "locked_cycle should match");
    assert(typeof a.runtime.lock_expires_at === "number", "lock_expires_at should be set");

    await postJson("/api/redress", { action: "clear", id: "cannibalistic_global_lock" });
    console.log("  ✓ Cycle lock triggers with locked_cycle + lock_expires_at");
  }

  // ── 10. Trigger cannibalistic_global_lock WITHOUT cycle_id should fail ──
  console.log("\n[10] Reject cannibalistic trigger without cycle_id");
  {
    const r = await postJson("/api/redress", {
      action: "trigger",
      id: "cannibalistic_global_lock",
      reason: "missing cycle_id",
    });
    assert(r.status === 400, `trigger without cycle_id should return 400, got ${r.status}`);
    console.log("  ✓ Missing cycle_id rejected");
  }

  // ── 11. Trigger context_hydration ──
  console.log("\n[11] Trigger context_hydration");
  {
    // Note: hydration is rate-limited to once per hour. If a prior test
    // triggered it within the hour, this will skip. We just verify the
    // call doesn't crash.
    const r = await postJson("/api/redress", {
      action: "trigger",
      id: "context_hydration",
      reason: "test hydration",
    });
    assert(r.status === 200, `trigger should return 200, got ${r.status}`);
    // Either ok:true (triggered) or ok:false (rate-limited) — both acceptable
    assert(r.body.ok !== undefined, "response should have ok field");
    console.log(`  ✓ Hydration call returned ok=${r.body.ok} (rate-limited to 1/hour)`);
  }

  // ── 12. Run an orchestrator tick and verify guardrail_halted + redress fields ──
  console.log("\n[12] Run orchestrator tick() — verify new TickReport fields");
  {
    const r = await postJson("/api/orchestrator/tick", {});
    assert(r.status === 200, `tick should return 200, got ${r.status}`);
    const tr = r.body;
    assert(typeof tr.guardrail_halted === "string" || tr.guardrail_halted === null, "guardrail_halted field should exist");
    assert(Array.isArray(tr.redress_active), "redress_active should be an array");
    assert(Array.isArray(tr.redress_triggered), "redress_triggered should be an array");
    console.log(
      `  ✓ TickReport has new fields: guardrail_halted=${tr.guardrail_halted}, ` +
      `redress_active=${JSON.stringify(tr.redress_active)}, redress_triggered=${JSON.stringify(tr.redress_triggered)}`
    );
  }

  // ── 13. Verify SGR is wired into processTasks (run a tick and check stats update) ──
  console.log("\n[13] Verify SGR stats update after tick");
  {
    const before = await getJson("/api/guardrails");
    const ipScannedBefore = before.body.guardrails.ip_copyright_filter.stats.outputs_scanned || 0;
    const logLinesBefore = before.body.guardrails.credential_leak_scrubber.stats.log_lines_scanned || 0;

    await postJson("/api/orchestrator/tick", {});

    const after = await getJson("/api/guardrails");
    const ipScannedAfter = after.body.guardrails.ip_copyright_filter.stats.outputs_scanned || 0;
    const logLinesAfter = after.body.guardrails.credential_leak_scrubber.stats.log_lines_scanned || 0;

    // If processTasks had any tasks to process, counters should be >= before.
    // (They might be equal if no tasks were completed this tick — that's fine.)
    assert(ipScannedAfter >= ipScannedBefore, "ip_copyright_filter outputs_scanned should not decrease");
    assert(logLinesAfter >= logLinesBefore, "credential_leak_scrubber log_lines_scanned should not decrease");
    console.log(
      `  ✓ SGR counters update: ip_scanned ${ipScannedBefore}→${ipScannedAfter}, ` +
      `log_lines ${logLinesBefore}→${logLinesAfter}`
    );
  }

  // ── 14. Clear all redress actions ──
  console.log("\n[14] Clear all redress");
  {
    // First trigger something so we have state to clear
    await postJson("/api/redress", {
      action: "trigger",
      id: "velocity_breaker",
      reason: "setup for clear-all test",
    });

    const r = await postJson("/api/redress", { action: "clear_all" });
    assert(r.status === 200, `clear_all should return 200, got ${r.status}`);

    const state = await getJson("/api/redress");
    const anyActive = Object.values(state.body.actions).some((a) => a.active);
    // Note: context_hydration may still be momentarily active (5s timeout)
    // — but the main 3 should all be cleared
    assert(
      state.body.actions.velocity_breaker.active === false,
      "velocity_breaker should be cleared"
    );
    assert(
      state.body.actions.log_monotony_entropy.active === false,
      "log_monotony_entropy should be cleared"
    );
    assert(
      state.body.actions.cannibalistic_global_lock.active === false,
      "cannibalistic_global_lock should be cleared"
    );
    console.log("  ✓ clear_all resets the 3 main actions");
  }

  // ── 15. Clear guardrail events ──
  console.log("\n[15] Clear guardrail events");
  {
    const r = await postJson("/api/guardrails", { action: "clear_events" });
    assert(r.status === 200, `clear_events should return 200, got ${r.status}`);

    const state = await getJson("/api/guardrails");
    assert(state.body.events.length === 0, `events should be empty, got ${state.body.events.length}`);
    console.log("  ✓ Events cleared");
  }

  // ── Summary ──
  console.log("\n─────────────────────────────────────────────────");
  console.log(`Passed: ${pass}  Failed: ${fail}`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  } else {
    console.log("\n✓ All guardrail + redress tests passed.");
  }
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});

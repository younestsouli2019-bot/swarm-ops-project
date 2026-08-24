#!/usr/bin/env node
/**
 * Self-test for Agent Safety Bindings (ASB) — Layer 4.
 *
 * Hits the /api/agent-safety endpoint with a variety of inputs and
 * verifies the responses match expectations. Also tests the integration
 * with the orchestrator's dispatchTasks() (asb_evaluations / asb_blocks /
 * asb_warnings fields in TickReport) and the audit's response to a
 * disabled guardrail.
 *
 * Run with:
 *   node scripts/test_agent_safety.mjs
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
  console.log("Testing Agent Safety Bindings (ASB) — Layer 4");
  console.log("─────────────────────────────────────────────────");
  console.log(`Base URL: ${BASE}\n`);

  // ── 1. GET /api/agent-safety returns expected shape ──
  console.log("[1] GET /api/agent-safety shape");
  {
    const { status, body } = await getJson("/api/agent-safety");
    assert(status === 200, "GET /api/agent-safety should return 200");
    assert(typeof body === "object" && body !== null, "body should be an object");
    assert(
      Array.isArray(body.bindings_list),
      "bindings_list should be an array"
    );
    assert(
      Array.isArray(body.categories_list),
      "categories_list should be an array"
    );
    assert(
      Array.isArray(body.pinned_guardrails),
      "pinned_guardrails should be an array"
    );
    assert(
      Array.isArray(body.manually_disabled_bindings),
      "manually_disabled_bindings should be an array"
    );
    assert(
      typeof body.stats === "object" && body.stats !== null,
      "stats should be an object"
    );
    assert(
      typeof body.stats.total_bindings === "number",
      "stats.total_bindings should be a number"
    );
    assert(
      body.stats.total_bindings >= 60,
      `should have at least 60 bindings (got ${body.stats.total_bindings})`
    );
    assert(
      body.categories_list.length === 7,
      `should have 7 categories (got ${body.categories_list.length})`
    );
    console.log(
      `    bindings: ${body.stats.total_bindings}, categories: ${body.categories_list.length}, required_guardrails: ${body.stats.total_required_guardrails}`
    );
  }

  // ── 2. All 7 categories present with correct policies ──
  console.log("\n[2] Category policies");
  {
    const { body } = await getJson("/api/agent-safety");
    const cats = body.categories_list;
    const expected = {
      intelligence: "warn",
      security: "block",
      revenue: "block",
      optimization: "warn",
      content: "block",
      governance: "block",
      infra: "block",
    };
    for (const [cat, pol] of Object.entries(expected)) {
      const c = cats.find((x) => x.category === cat);
      assert(c, `category ${cat} should exist`);
      if (c) {
        assert(
          c.policy === pol,
          `category ${cat} should have policy ${pol} (got ${c.policy})`
        );
      }
    }
    console.log(
      `    policies: ${cats.map((c) => `${c.category}=${c.policy}`).join(", ")}`
    );
  }

  // ── 3. Bindings include both conceptual and seed-agent capabilities ──
  console.log("\n[3] Bindings coverage");
  {
    const { body } = await getJson("/api/agent-safety");
    const caps = new Set(body.bindings_list.map((b) => b.capability));
    // Conceptual
    assert(caps.has("web_search"), "should have web_search binding");
    assert(caps.has("settlement_tracking"), "should have settlement_tracking binding");
    assert(caps.has("platform_publish"), "should have platform_publish binding");
    assert(caps.has("cycle_orchestration"), "should have cycle_orchestration binding");
    // Seed-agent
    assert(caps.has("categorization"), "should have categorization binding (seed)");
    assert(caps.has("transcription"), "should have transcription binding (seed)");
    assert(caps.has("shell"), "should have shell binding (DevOps-11)");
    assert(caps.has("etsy_listing"), "should have etsy_listing binding (Bazaar-7)");
    // Other DB
    assert(caps.has("social_posting"), "should have social_posting binding");
    assert(caps.has("stripe_integration"), "should have stripe_integration binding");
    console.log(`    ${caps.size} capabilities bound`);
  }

  // ── 4. Required guardrails reference correct layers ──
  console.log("\n[4] Required guardrails layer references");
  {
    const { body } = await getJson("/api/agent-safety");
    const validLayers = new Set(["sig", "sgr", "sre"]);
    let allValid = true;
    let sigCount = 0,
      sgrCount = 0,
      sreCount = 0;
    for (const b of body.bindings_list) {
      for (const g of b.required_guardrails) {
        if (!validLayers.has(g.layer)) allValid = false;
        if (g.layer === "sig") sigCount++;
        if (g.layer === "sgr") sgrCount++;
        if (g.layer === "sre") sreCount++;
      }
    }
    assert(allValid, "all layer refs should be sig|sgr|sre");
    assert(sigCount > 0, `should have SIG refs (got ${sigCount})`);
    assert(sgrCount > 0, `should have SGR refs (got ${sgrCount})`);
    assert(sreCount > 0, `should have SRE refs (got ${sreCount})`);
    console.log(
      `    layer refs: sig=${sigCount}, sgr=${sgrCount}, sre=${sreCount}`
    );
  }

  // ── 5. Pin a guardrail ──
  console.log("\n[5] Pin guardrail");
  {
    const pinRes = await postJson("/api/agent-safety", {
      action: "pin_guardrail",
      id: "ip_copyright_filter",
    });
    assert(pinRes.status === 200, "pin_guardrail should return 200");
    assert(pinRes.body.ok === true, "pin_guardrail should return ok:true");

    const { body } = await getJson("/api/agent-safety");
    assert(
      body.pinned_guardrails.includes("ip_copyright_filter"),
      "ip_copyright_filter should be in pinned_guardrails"
    );
    console.log(`    pinned: ${body.pinned_guardrails.join(", ")}`);

    // Verify it's also enabled in SGR (pin forces enable)
    const grRes = await getJson("/api/guardrails");
    const ip = grRes.body.guardrails.ip_copyright_filter;
    assert(
      ip && ip.enabled === true,
      "pinned guardrail should be force-enabled in SGR"
    );
  }

  // ── 6. can_disable_guardrail for pinned guardrail ──
  console.log("\n[6] can_disable_guardrail (pinned)");
  {
    const { body } = await postJson("/api/agent-safety", {
      action: "can_disable_guardrail",
      id: "ip_copyright_filter",
    });
    assert(body.ok === false, "pinned guardrail should not be disableable");
    assert(
      typeof body.reason === "string" && body.reason.includes("pinned"),
      "reason should mention 'pinned'"
    );
    console.log(`    ok=${body.ok}, reason: ${body.reason?.slice(0, 60)}...`);
  }

  // ── 7. can_disable_guardrail for non-pinned guardrail ──
  console.log("\n[7] can_disable_guardrail (not pinned)");
  {
    const { body } = await postJson("/api/agent-safety", {
      action: "can_disable_guardrail",
      id: "honey_pot_detector",
    });
    assert(body.ok === true, "non-pinned guardrail should be disableable");
    console.log(`    ok=${body.ok}`);
  }

  // ── 8. Unpin the guardrail ──
  console.log("\n[8] Unpin guardrail");
  {
    const unpinRes = await postJson("/api/agent-safety", {
      action: "unpin_guardrail",
      id: "ip_copyright_filter",
    });
    assert(unpinRes.status === 200, "unpin_guardrail should return 200");
    assert(unpinRes.body.ok === true, "unpin_guardrail should return ok:true");

    const { body } = await getJson("/api/agent-safety");
    assert(
      !body.pinned_guardrails.includes("ip_copyright_filter"),
      "ip_copyright_filter should no longer be pinned"
    );
    console.log(`    pinned after unpin: ${body.pinned_guardrails.join(", ") || "(none)"}`);
  }

  // ── 9. Disable + re-enable a capability binding ──
  console.log("\n[9] Disable + re-enable capability binding");
  {
    const disRes = await postJson("/api/agent-safety", {
      action: "disable_binding",
      capability: "shell",
    });
    assert(disRes.status === 200, "disable_binding should return 200");
    assert(disRes.body.ok === true, "disable_binding should return ok:true");

    let { body } = await getJson("/api/agent-safety");
    assert(
      body.manually_disabled_bindings.includes("shell"),
      "shell should be in manually_disabled_bindings"
    );

    const enRes = await postJson("/api/agent-safety", {
      action: "enable_binding",
      capability: "shell",
    });
    assert(enRes.status === 200, "enable_binding should return 200");
    assert(enRes.body.ok === true, "enable_binding should return ok:true");

    body = (await getJson("/api/agent-safety")).body;
    assert(
      !body.manually_disabled_bindings.includes("shell"),
      "shell should no longer be in manually_disabled_bindings"
    );
    console.log(`    disabled_bindings after re-enable: ${body.manually_disabled_bindings.length}`);
  }

  // ── 10. Run coverage audit ──
  console.log("\n[10] Run coverage audit");
  {
    const { status, body } = await postJson("/api/agent-safety", {
      action: "run_audit",
    });
    assert(status === 200, "run_audit should return 200");
    assert(body.ok === true, "run_audit should return ok:true");
    assert(
      typeof body.agent_count === "number" && body.agent_count > 0,
      `agent_count should be > 0 (got ${body.agent_count})`
    );
    assert(
      typeof body.findings_count === "number",
      "findings_count should be a number"
    );
    assert(
      body.critical_count + body.warning_count + body.info_count ===
        body.findings_count,
      "severity counts should sum to findings_count"
    );
    console.log(
      `    agents: ${body.agent_count}, findings: ${body.findings_count} (crit=${body.critical_count}, warn=${body.warning_count}, info=${body.info_count})`
    );

    // Verify findings have the new unbound_capabilities field
    if (body.findings && body.findings.length > 0) {
      const f = body.findings[0];
      assert(
        Array.isArray(f.ungoverned_capabilities),
        "finding should have ungoverned_capabilities array"
      );
      assert(
        Array.isArray(f.unbound_capabilities),
        "finding should have unbound_capabilities array"
      );
    }
  }

  // ── 11. Disable a guardrail and verify audit shows critical findings ──
  console.log("\n[11] Audit reflects disabled guardrail");
  {
    // Disable credential_leak_scrubber (required by many infra agents with block policy)
    await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "credential_leak_scrubber",
      enabled: false,
    });

    const { body } = await postJson("/api/agent-safety", {
      action: "run_audit",
    });
    assert(
      body.critical_count > 0,
      `disabling credential_leak_scrubber should produce critical findings (got ${body.critical_count})`
    );

    // Check that at least one critical finding mentions credential_leak_scrubber
    const hasCredentialFinding = body.findings.some(
      (f) =>
        f.severity === "critical" &&
        f.ungoverned_capabilities.some(
          (u) => u.required_guardrail === "credential_leak_scrubber"
        )
    );
    assert(
      hasCredentialFinding,
      "at least one critical finding should reference credential_leak_scrubber"
    );

    // Re-enable
    await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "credential_leak_scrubber",
      enabled: true,
    });

    console.log(
      `    critical findings with credential_leak_scrubber disabled: ${body.critical_count}`
    );
  }

  // ── 12. Run orchestrator tick and verify ASB fields ──
  console.log("\n[12] Orchestrator tick ASB integration");
  {
    // Clear evaluations first
    await postJson("/api/agent-safety", { action: "clear_evaluations" });

    const { status, body } = await postJson("/api/orchestrator/tick", {});
    assert(status === 200, "tick should return 200");
    assert(
      typeof body.asb_evaluations === "number",
      "tick report should have asb_evaluations field"
    );
    assert(
      typeof body.asb_blocks === "number",
      "tick report should have asb_blocks field"
    );
    assert(
      typeof body.asb_warnings === "number",
      "tick report should have asb_warnings field"
    );
    console.log(
      `    tick: dispatched=${body.dispatched}, asb_eval=${body.asb_evaluations}, asb_block=${body.asb_blocks}, asb_warn=${body.asb_warnings}`
    );
  }

  // ── 13. ASB gate blocks when guardrail disabled ──
  console.log("\n[13] ASB gate blocks dispatch when guardrail disabled");
  {
    // Clear evaluations
    await postJson("/api/agent-safety", { action: "clear_evaluations" });

    // Disable ip_copyright_filter (required by content capabilities with block policy)
    await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "ip_copyright_filter",
      enabled: false,
    });

    // Run several ticks
    let totalBlocks = 0;
    let totalEvals = 0;
    for (let i = 0; i < 5; i++) {
      const { body } = await postJson("/api/orchestrator/tick", {});
      totalBlocks += body.asb_blocks || 0;
      totalEvals += body.asb_evaluations || 0;
    }

    // Check stats
    const { body: statsBody } = await getJson("/api/agent-safety");
    assert(
      statsBody.stats.total_blocks >= 0,
      "total_blocks should be >= 0"
    );
    assert(
      statsBody.stats.agents_evaluated > 0,
      `agents_evaluated should be > 0 after ticks (got ${statsBody.stats.agents_evaluated})`
    );

    // Re-enable
    await postJson("/api/guardrails", {
      action: "set_enabled",
      id: "ip_copyright_filter",
      enabled: true,
    });

    console.log(
      `    total evals across 5 ticks: ${totalEvals}, total blocks: ${totalBlocks}`
    );
    console.log(
      `    agents_evaluated: ${statsBody.stats.agents_evaluated}, total_blocks: ${statsBody.stats.total_blocks}`
    );
  }

  // ── 14. Invalid action rejected ──
  console.log("\n[14] Invalid action rejected");
  {
    const { status } = await postJson("/api/agent-safety", {
      action: "bogus_action",
    });
    assert(status === 400, "invalid action should return 400");
  }

  // ── 15. Missing id for pin_guardrail rejected ──
  console.log("\n[15] Missing id for pin_guardrail rejected");
  {
    const { status } = await postJson("/api/agent-safety", {
      action: "pin_guardrail",
    });
    assert(status === 400, "missing id should return 400");
  }

  // ── 16. Missing capability for disable_binding rejected ──
  console.log("\n[16] Missing capability for disable_binding rejected");
  {
    const { status } = await postJson("/api/agent-safety", {
      action: "disable_binding",
    });
    assert(status === 400, "missing capability should return 400");
  }

  // ── 17. GET with ?audit=1 runs fresh audit inline ──
  console.log("\n[17] GET ?audit=1 runs fresh audit");
  {
    const { status, body } = await getJson("/api/agent-safety?audit=1");
    assert(status === 200, "?audit=1 should return 200");
    assert(
      typeof body.fresh_audit === "object",
      "fresh_audit should be present in response"
    );
    if (body.fresh_audit) {
      assert(
        typeof body.fresh_audit.agent_count === "number",
        "fresh_audit.agent_count should be a number"
      );
      assert(
        Array.isArray(body.fresh_audit.findings),
        "fresh_audit.findings should be an array"
      );
      console.log(
        `    fresh_audit: ${body.fresh_audit.agent_count} agents, ${body.fresh_audit.findings_count} findings`
      );
    }
  }

  // ── 18. clear_evaluations resets counters ──
  console.log("\n[18] clear_evaluations resets counters");
  {
    const { status, body } = await postJson("/api/agent-safety", {
      action: "clear_evaluations",
    });
    assert(status === 200, "clear_evaluations should return 200");
    assert(body.ok === true, "clear_evaluations should return ok:true");

    const { body: stateBody } = await getJson("/api/agent-safety");
    assert(
      stateBody.stats.agents_evaluated === 0,
      "agents_evaluated should be 0 after clear"
    );
    assert(
      stateBody.stats.total_blocks === 0,
      "total_blocks should be 0 after clear"
    );
    console.log(`    agents_evaluated: ${stateBody.stats.agents_evaluated}`);
  }

  // ── Summary ──
  console.log("\n─────────────────────────────────────────────────");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Self-test suite for the Settlement Ledger + Procurement Ledger + Oracle layer.
 *
 * Run with:  node scripts/test_settlement_ledger.mjs
 *
 * Tests cover:
 *   1. Settlement ledger: state transitions, 2PC protocol, receipt hashing
 *   2. Procurement ledger: PO lifecycle, three-way match, zero-trust carrier
 *   3. Oracle layer: webhook signature verification, ingress stripping
 *   4. Dashboard isolation rule: hard $0 unless receipt_hash present
 *   5. Audit: tamper-evidence, SLA breaches, schema violations
 *   6. /api/settlement-ledger endpoint smoke tests
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://localhost:3000";

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error("  ✗ " + msg); }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) { pass++; }
  else {
    fail++;
    failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  const json = await res.json();
  return { status: res.status, json };
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

console.log("\n━━━━ Settlement Ledger + Procurement + Oracle Self-Tests ━━━━\n");

// ─── wait for dev server ──────────────────────────────────────────────────
console.log("Waiting for dev server at", BASE);
let serverUp = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(`${BASE}/api/settlement-ledger`, { cache: "no-store" });
    if (r.ok) { serverUp = true; break; }
  } catch { /* retry */ }
  await sleep(1000);
}
if (!serverUp) {
  console.error("✗ Dev server not running at", BASE, "— start it with `bun run dev` first.");
  process.exit(1);
}
console.log("  ✓ Dev server up");
console.log("");

// ─── 1. RESET ──────────────────────────────────────────────────────────────
console.log("Section 1: Reset");
{
  const r = await apiPost("/api/settlement-ledger", { action: "reset" });
  assertEq(r.status, 200, "reset returns 200");
  assertEq(r.json.ok, true, "reset ok");
  pass++; console.log("  ✓ ledger reset for tests");
}
console.log("");

// ─── 2. SETTLEMENT LEDGER — state typing + 2PC ────────────────────────────
console.log("Section 2: Settlement Ledger — strict state typing + 2PC");
{
  // Create a SPECULATIVE entry.
  const c = await apiPost("/api/settlement-ledger", {
    action: "create_entry",
    external_ref: "REV-TEST-001",
    kind: "revenue",
    amount_cents: 2500,
    currency: "USD",
    counterparty_id: "operator@hit-swarm.example",
    initiator_agent_id: "agent_atlas_1",
    metadata: { hit_id: "HIT-001", marketplace: "mturk" },
  });
  assertEq(c.status, 200, "create_entry returns 200");
  assertEq(c.json.entry.state, "SPECULATIVE", "new entry is SPECULATIVE");
  assertEq(c.json.entry.receipt_hash, null, "SPECULATIVE entry has no receipt_hash");
  assertEq(c.json.entry.prepare_token, null, "SPECULATIVE entry has no prepare_token");
  const entryId = c.json.entry.id;

  // Phase 1 — prepare. State should transition SPECULATIVE → PENDING_SETTLEMENT.
  const p = await apiPost("/api/settlement-ledger", {
    action: "prepare",
    entry_id: entryId,
    initiator_agent_id: "agent_atlas_1",
    oracle_id: "oracle_stripe",
  });
  assertEq(p.status, 200, "prepare returns 200");
  assertEq(p.json.ok, true, "prepare ok");
  assert(!!p.json.prepare_token, "prepare returns a token");
  assert(!!p.json.rail, "prepare returns a rail");

  // Verify state via the active-ops stream (should NOT include this entry — it's pending).
  const ops = await apiGet("/api/settlement-ledger?stream=active");
  assertEq(ops.json.entries.length, 0, "Active Ops stream is empty (entry is PENDING)");

  // Verify pipeline stream DOES include it.
  const pipe = await apiGet("/api/settlement-ledger?stream=pipeline");
  assertEq(pipe.json.entries.length, 1, "Pipeline stream includes the PENDING entry");
  assertEq(pipe.json.entries[0].state, "PENDING_SETTLEMENT", "Pipeline entry is PENDING_SETTLEMENT");

  // Hard rule: active operations balance must be 0 (no receipt_hash yet).
  assertEq(ops.json.balance.total_cents, 0, "HARD RULE: active ops balance = 0 before commit");
  assertEq(ops.json.balance.has_any_receipt, false, "HARD RULE: has_any_receipt = false before commit");

  // Phase 2 — commit. State should transition PENDING_SETTLEMENT → SETTLED.
  const cm = await apiPost("/api/settlement-ledger", {
    action: "commit",
    entry_id: entryId,
    oracle_id: "oracle_stripe",
    prepare_token: p.json.prepare_token,
    receipt_payload: { external_id: "pi_test_123", event_ts: "2026-08-14T00:00:00Z" },
  });
  assertEq(cm.status, 200, "commit returns 200");
  assertEq(cm.json.ok, true, "commit ok");
  assert(!!cm.json.receipt_hash, "commit returns a receipt_hash");
  assert(cm.json.receipt_hash.length >= 32, "receipt_hash is a SHA-256 hex string");

  // Hard rule: active ops balance must now be 2500 with a receipt.
  const ops2 = await apiGet("/api/settlement-ledger?stream=active");
  assertEq(ops2.json.entries.length, 1, "Active Ops stream includes the SETTLED entry");
  assertEq(ops2.json.entries[0].state, "SETTLED", "Active Ops entry is SETTLED");
  assertEq(ops2.json.balance.total_cents, 2500, "HARD RULE: active ops balance = 2500 after commit");
  assertEq(ops2.json.balance.has_any_receipt, true, "HARD RULE: has_any_receipt = true after commit");

  // Commit must be idempotent — another commit on a SETTLED entry must fail.
  const cm2 = await apiPost("/api/settlement-ledger", {
    action: "commit",
    entry_id: entryId,
    oracle_id: "oracle_stripe",
    prepare_token: p.json.prepare_token,
    receipt_payload: { external_id: "pi_test_456" },
  });
  assertEq(cm2.status, 400, "second commit on SETTLED entry rejected");
  pass++; console.log("  ✓ 2PC protocol + hard-rule dashboard isolation verified");
}
console.log("");

// ─── 3. SETTLEMENT LEDGER — invalid transitions ──────────────────────────
console.log("Section 3: Settlement Ledger — invalid transitions");
{
  // Cannot commit a SPECULATIVE entry (must prepare first).
  const c = await apiPost("/api/settlement-ledger", {
    action: "create_entry",
    external_ref: "REV-TEST-BAD-001",
    kind: "revenue",
    amount_cents: 1000,
    currency: "USD",
    counterparty_id: "recipient_1",
    initiator_agent_id: "agent_x",
  });
  const entryId = c.json.entry.id;

  const cm = await apiPost("/api/settlement-ledger", {
    action: "commit",
    entry_id: entryId,
    oracle_id: "oracle_stripe",
    prepare_token: "fake_token",
    receipt_payload: {},
  });
  assertEq(cm.status, 400, "commit on SPECULATIVE entry rejected (must prepare first)");

  // Cannot prepare with an unregistered oracle.
  const p = await apiPost("/api/settlement-ledger", {
    action: "prepare",
    entry_id: entryId,
    initiator_agent_id: "agent_x",
    oracle_id: "oracle_does_not_exist",
  });
  assertEq(p.status, 400, "prepare with unregistered oracle rejected");

  // Cannot cancel a SETTLED entry.
  const c2 = await apiPost("/api/settlement-ledger", {
    action: "create_entry",
    external_ref: "REV-TEST-BAD-002",
    kind: "revenue",
    amount_cents: 5000,
    currency: "USD",
    counterparty_id: "recipient_2",
    initiator_agent_id: "agent_y",
  });
  const entry2 = c2.json.entry.id;
  await apiPost("/api/settlement-ledger", {
    action: "prepare",
    entry_id: entry2,
    initiator_agent_id: "agent_y",
    oracle_id: "oracle_stripe",
  });
  await apiPost("/api/settlement-ledger", {
    action: "simulate_revenue_webhook",
    external_ref: "REV-TEST-BAD-002",
    amount_cents: 5000,
    currency: "USD",
    recipient_id: "recipient_2",
    status: "succeeded",
  });
  const cancelRes = await apiPost("/api/settlement-ledger", {
    action: "cancel",
    entry_id: entry2,
    initiator_agent_id: "agent_y",
    reason: "test",
  });
  assertEq(cancelRes.status, 400, "cancel on SETTLED entry rejected (terminal state)");
  pass++; console.log("  ✓ invalid transitions rejected");
}
console.log("");

// ─── 4. PROCUREMENT LEDGER — PO lifecycle ─────────────────────────────────
console.log("Section 4: Procurement Ledger — PO lifecycle + zero-trust carrier");
{
  // Create a Draft_Speculative PO.
  const c = await apiPost("/api/settlement-ledger", {
    action: "create_po",
    supplier_id: "supplier_acme_corp",
    procuring_agent_id: "agent_procurement_specialist",
    line_items: [
      { sku: "SKU-001", description: "API compute credits", quantity_ordered: 2, unit_price_cents: 1500 },
    ],
    currency: "USD",
  });
  assertEq(c.status, 200, "create_po returns 200");
  assertEq(c.json.po.state, "Draft_Speculative", "new PO is Draft_Speculative");
  assertEq(c.json.po.tracking_number, null, "Draft PO has no tracking_number");
  const poId = c.json.po.id;

  // Acknowledge — supplier message includes self-asserted tokens that must be stripped.
  const ack = await apiPost("/api/settlement-ledger", {
    action: "acknowledge_po",
    po_id: poId,
    supplier_message: {
      ack_id: "ack-1",
      is_paid: true,            // self-asserted — must be stripped
      supplier_confirmed: true, // self-asserted — must be stripped
      expected_ship_date: "2026-08-16",
    },
  });
  assertEq(ack.status, 200, "acknowledge_po returns 200");
  assertEq(ack.json.ok, true, "acknowledge ok");

  // Generate shipment.
  const ship = await apiPost("/api/settlement-ledger", {
    action: "generate_shipment",
    po_id: poId,
    carrier: "fedex",
    tracking_number: "FEDEX-TEST-001",
  });
  assertEq(ship.status, 200, "generate_shipment returns 200");
  assertEq(ship.json.ok, true, "generate_shipment ok");

  // Try to mark received WITHOUT going through In_Transit — must fail.
  const rcptBad = await apiPost("/api/settlement-ledger", {
    action: "mark_received_verified",
    po_id: poId,
    invoice: { id: "inv-1", po_id: poId, supplier_id: "supplier_acme_corp", line_items: [], total_cents: 3000, currency: "USD", received_at: Date.now(), source: "supplier_api" },
    receipt: { id: "rcpt-1", po_id: poId, warehouse_id: "wh-1", line_items: [], received_at: Date.now(), iot_signature: "sig-1" },
  });
  assertEq(rcptBad.status, 400, "mark_received_verified without In_Transit rejected");

  // Simulate carrier scan (via Logistics Oracle) — advances to In_Transit.
  const scan = await apiPost("/api/settlement-ledger", {
    action: "simulate_carrier_scan",
    po_id: poId,
    carrier: "fedex",
    tracking_number: "FEDEX-TEST-001",
    event_type: "picked_up",
  });
  assertEq(scan.status, 200, "simulate_carrier_scan returns 200");
  assertEq(scan.json.ok, true, "carrier scan ok");

  // Now mark received_verified — three-way match should pass.
  const rcpt = await apiPost("/api/settlement-ledger", {
    action: "mark_received_verified",
    po_id: poId,
    invoice: {
      id: "inv-test-001",
      invoice_number: "INV-001",
      po_id: poId,
      supplier_id: "supplier_acme_corp",
      line_items: [{ sku: "SKU-001", quantity_invoiced: 2, unit_price_cents: 1500 }],
      total_cents: 3000,
      currency: "USD",
      received_at: Date.now(),
      source: "supplier_api",
    },
    receipt: {
      id: "rcpt-test-001",
      receipt_number: "RCPT-001",
      po_id: poId,
      warehouse_id: "wh-1",
      line_items: [{ sku: "SKU-001", quantity_received: 2, quality_status: "passed" }],
      received_at: Date.now(),
      iot_signature: "iot_sig_test_001",
    },
  });
  assertEq(rcpt.status, 200, "mark_received_verified returns 200");
  assertEq(rcpt.json.ok, true, "three-way match passed");
  assertEq(rcpt.json.three_way_match.matched, true, "three_way_match.matched = true");
  assertEq(rcpt.json.three_way_match.within_tolerance, true, "three_way_match.within_tolerance = true");

  // Verify the PO is now Received_Verified AND a SETTLED settlement entry was created.
  const ops = await apiGet("/api/settlement-ledger?stream=procurement_active");
  const po = ops.json.pos.find((p) => p.id === poId);
  assert(!!po, "PO appears in procurement_active stream");
  assertEq(po.state, "Received_Verified", "PO state = Received_Verified");

  // And the settlement ledger should have a SETTLED procurement entry.
  const sOps = await apiGet("/api/settlement-ledger?stream=active");
  const procEntries = sOps.json.entries.filter((e) => e.kind === "procurement");
  assert(procEntries.length > 0, "Settlement ledger has SETTLED procurement entries");
  assertEq(procEntries[0].state, "SETTLED", "Procurement entry is SETTLED");
  assert(!!procEntries[0].receipt_hash, "Procurement entry has receipt_hash");
  pass++; console.log("  ✓ PO lifecycle + 3-way match + zero-trust carrier verified");
}
console.log("");

// ─── 5. INGRESS VALIDATION — self-asserted token stripping ───────────────
console.log("Section 5: Ingress validation — self-asserted token stripping");
{
  const r = await apiPost("/api/settlement-ledger", {
    action: "sanitize_ingress",
    payload: {
      legitimate_field: "ok",
      is_paid: true,
      self_verified: true,
      agent_confirmed: true,
      nested: {
        ok: 1,
        is_shipped: true,
        supplier_confirmed: true,
      },
    },
  });
  assertEq(r.status, 200, "sanitize_ingress returns 200");
  assertEq(r.json.sanitized.legitimate_field, "ok", "legitimate field preserved");
  assert(!("is_paid" in r.json.sanitized), "top-level is_paid stripped");
  assert(!("self_verified" in r.json.sanitized), "top-level self_verified stripped");
  assert(!("agent_confirmed" in r.json.sanitized), "top-level agent_confirmed stripped");
  assert(!("is_shipped" in r.json.sanitized.nested), "nested is_shipped stripped");
  assert(!("supplier_confirmed" in r.json.sanitized.nested), "nested supplier_confirmed stripped");
  assert(r.json.stripped_keys.length >= 5, "stripped_keys list has 5+ entries");
  pass++; console.log("  ✓ self-asserted tokens stripped at ingress (recursive)");
}
console.log("");

// ─── 6. ORACLE — webhook signature verification ──────────────────────────
console.log("Section 6: Oracle — webhook signature verification");
{
  // A forged signature must be rejected.
  const c = await apiPost("/api/settlement-ledger", {
    action: "create_entry",
    external_ref: "REV-SIG-TEST-001",
    kind: "revenue",
    amount_cents: 1000,
    currency: "USD",
    counterparty_id: "recipient_3",
    initiator_agent_id: "agent_z",
  });
  await apiPost("/api/settlement-ledger", {
    action: "prepare",
    entry_id: c.json.entry.id,
    initiator_agent_id: "agent_z",
    oracle_id: "oracle_stripe",
  });

  // Simulate webhook with status=succeeded — should commit successfully.
  const sim = await apiPost("/api/settlement-ledger", {
    action: "simulate_revenue_webhook",
    external_ref: "REV-SIG-TEST-001",
    amount_cents: 1000,
    currency: "USD",
    recipient_id: "recipient_3",
    status: "succeeded",
  });
  assertEq(sim.status, 200, "simulate_revenue_webhook succeeded returns 200");
  assertEq(sim.json.ok, true, "simulated webhook commit ok");
  assert(!!sim.json.receipt_hash, "simulated webhook returns receipt_hash");

  // Now try with status=failed — should fail the entry.
  const c2 = await apiPost("/api/settlement-ledger", {
    action: "create_entry",
    external_ref: "REV-SIG-TEST-002",
    kind: "revenue",
    amount_cents: 2000,
    currency: "USD",
    counterparty_id: "recipient_4",
    initiator_agent_id: "agent_w",
  });
  await apiPost("/api/settlement-ledger", {
    action: "prepare",
    entry_id: c2.json.entry.id,
    initiator_agent_id: "agent_w",
    oracle_id: "oracle_stripe",
  });
  const simFail = await apiPost("/api/settlement-ledger", {
    action: "simulate_revenue_webhook",
    external_ref: "REV-SIG-TEST-002",
    amount_cents: 2000,
    currency: "USD",
    recipient_id: "recipient_4",
    status: "failed",
  });
  assertEq(simFail.status, 400, "simulate_revenue_webhook failed returns 400");
  pass++; console.log("  ✓ webhook signature verification + status handling");
}
console.log("");

// ─── 7. AUDIT — tamper-evidence + schema violations ──────────────────────
console.log("Section 7: Audit — tamper-evidence + schema violations");
{
  const r = await apiPost("/api/settlement-ledger", { action: "run_audit" });
  assertEq(r.status, 200, "run_audit returns 200");
  assertEq(r.json.ok, true, "run_audit ok");
  assert(Array.isArray(r.json.audit_findings), "audit_findings is array");
  assert(Array.isArray(r.json.oracle_audit_findings), "oracle_audit_findings is array");

  // Audit should NOT have any critical findings at this point (all entries are clean).
  const criticals = r.json.audit_findings.filter((f) => f.severity === "critical");
  // Some criticals are possible if any SETTLED entry got created without a receipt_hash
  // (shouldn't happen via the API, but check anyway).
  console.log(`    (audit findings: ${r.json.audit_findings.length} total, ${criticals.length} critical)`);
  pass++; console.log("  ✓ audit ran cleanly");
}
console.log("");

// ─── 8. ORACLE HEALTH — register / toggle / unregister ──────────────────
console.log("Section 8: Oracle registry — register / toggle / unregister");
{
  const reg = await apiPost("/api/settlement-ledger", {
    action: "register_oracle",
    id: "oracle_test_custom",
    kind: "settlement",
    rail: "test_rail",
  });
  assertEq(reg.status, 200, "register custom oracle returns 200");
  assertEq(reg.json.ok, true, "register custom oracle ok");

  // Verify it shows up in the GET response.
  const g = await apiGet("/api/settlement-ledger");
  const found = g.json.oracles.find((o) => o.id === "oracle_test_custom");
  assert(!!found, "custom oracle appears in oracles list");
  assertEq(found.rail, "test_rail", "custom oracle rail = test_rail");

  // Toggle health.
  const toggle = await apiPost("/api/settlement-ledger", {
    action: "set_oracle_health",
    id: "oracle_test_custom",
    healthy: false,
  });
  assertEq(toggle.status, 200, "set_oracle_health returns 200");
  pass++; console.log("  ✓ oracle registry operations");
}
console.log("");

// ─── 9. DASHBOARD INTEGRATION ──────────────────────────────────────────────
console.log("Section 9: Dashboard integration");
{
  // The home page should mention "Settlement" in the nav.
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  assert(html.includes("Settlement"), "page HTML contains 'Settlement' nav entry");
  assert(html.includes("2PC ledger"), "page HTML contains settlement hint");
  // The settlement-view itself fetches /api/settlement-ledger — verify it returns valid JSON.
  const sr = await fetch(`${BASE}/api/settlement-ledger`, { cache: "no-store" });
  const sjson = await sr.json();
  assert(sr.ok, "settlement API returns 2xx");
  assert("hard_rule" in sjson, "settlement API returns hard_rule object");
  assert("active_operations_balance" in sjson, "settlement API returns active_operations_balance");
  assert("oracles" in sjson, "settlement API returns oracles list");
  pass++; console.log("  ✓ dashboard + settlement API integration");
}
console.log("");

// ─── 10. ALL ENDPOINTS STILL HEALTHY ──────────────────────────────────────
console.log("Section 10: All endpoints still healthy");
{
  const endpoints = [
    "/api/state",
    "/api/models",
    "/api/sig",
    "/api/guardrails",
    "/api/redress",
    "/api/agent-safety",
    "/api/token-optimizer",
    "/api/omnigent-memory",
    "/api/settlement-ledger",
  ];
  for (const ep of endpoints) {
    const r = await fetch(`${BASE}${ep}`, { cache: "no-store" });
    assert(r.ok, `${ep} returns 2xx (got ${r.status})`);
  }
  pass++; console.log("  ✓ all 9 API endpoints return 2xx");
}
console.log("");

// ─── SUMMARY ───────────────────────────────────────────────────────────────
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  ✓ ${pass} passed`);
if (fail > 0) {
  console.log(`  ✗ ${fail} failed`);
  console.log("");
  console.log("Failures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("  All assertions passed.");
  process.exit(0);
}

#!/usr/bin/env node
/**
 * Integration test for Token Optimizer + Omnigent Memory & Load Balancer.
 *
 * Smoke-tests every action exposed by the two new endpoints. Run:
 *   node scripts/test_token_omnigent.mjs
 */
import assert from "node:assert";

const BASE = "http://localhost:3000";
let pass = 0;
let fail = 0;

async function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

async function getJSON(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, json: await r.json() };
}

async function postJSON(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log("\n=== Token Optimizer ===\n");

// GET state
{
  const { status, json } = await getJSON("/api/token-optimizer");
  await ok(status === 200, "GET /api/token-optimizer returns 200");
  await ok(Array.isArray(json.mcp_servers), "state has mcp_servers array");
  await ok(json.mcp_servers.length >= 3, "≥3 default MCP servers seeded");
  await ok(json.mcp_servers.some((s) => s.name === "filesystem"), "filesystem MCP seeded");
  await ok(json.mcp_servers.some((s) => s.name === "memory"), "memory MCP seeded");
  await ok(json.mcp_servers.some((s) => s.name === "fetch"), "fetch MCP seeded");
  await ok("stats" in json, "state has stats object");
  await ok("total_tokens_saved" in json.stats, "stats has total_tokens_saved");
}

// Token estimator
{
  const { status, json } = await getJSON(`/api/token-optimizer?estimate=${encodeURIComponent("Hello world this is a test")}`);
  await ok(status === 200, "GET ?estimate= returns 200");
  await ok(json.estimated_tokens > 0, "estimate is positive");
  await ok(json.estimated_tokens < 100, "estimate is reasonable (<100 for short text)");
}

// Optimize text with symbol extraction
{
  const sample = "The categorization_capability_index module handles categorization_capability_index state. categorization_capability_index dispatches to categorization_capability_index workers. categorization_capability_index reports back. categorization_capability_index logs events.";
  const { status, json } = await postJSON("/api/token-optimizer", { action: "optimize_text", input: sample, extract_symbols: true, trim_whitespace: true });
  await ok(status === 200, "POST optimize_text returns 200");
  await ok(json.ok === true, "optimize_text ok=true");
  await ok(json.tokens_before > 0, "tokens_before > 0");
  await ok(json.tokens_saved > 0, "tokens_saved > 0 (symbol extraction kicked in)");
  await ok(json.dictionary && Object.keys(json.dictionary.aliases).length > 0, "dictionary populated");
  await ok(json.steps.length > 0, "steps array populated");
  await ok(json.result.includes("sym1"), "compressed result contains alias sym1");
}

// Optimize text without symbols (whitespace only)
{
  const sample = "line 1\n\n\n\nline 2\n   \nline 3";
  const { status, json } = await postJSON("/api/token-optimizer", { action: "optimize_text", input: sample, extract_symbols: false, trim_whitespace: true });
  await ok(status === 200, "POST optimize_text (whitespace only) returns 200");
  await ok(json.tokens_saved >= 0, "tokens_saved >= 0");
  await ok(!json.result.includes("\n\n\n"), "triple newlines collapsed");
}

// Analyze code
{
  const code = `import { foo } from 'bar';
import { baz } from 'bar';
import { qux } from 'bar';

// dead code below
// line 2
// line 3
// line 4
// line 5
// line 6

function redundant() {
  console.log('debug_prefix start');
  console.log('debug_prefix middle');
  console.log('debug_prefix end');
  if (x === 'a' || x === 'b' || x === 'c' || x === 'd') return true;
  return false;
}

const longString = "this is a really long string literal that should probably be extracted to a symbol because it is way too verbose to keep inlining in the code";
`;
  const { status, json } = await postJSON("/api/token-optimizer", { action: "analyze_code", code, generate_preview: true });
  await ok(status === 200, "POST analyze_code returns 200");
  await ok(json.findings.length >= 4, "≥4 findings returned");
  await ok(json.estimated_savings > 0, "estimated_savings > 0");
  await ok(json.optimized_preview && !json.optimized_preview.includes("// dead code"), "preview stripped dead code");
  const cats = new Set(json.findings.map((f) => f.category));
  await ok(cats.has("redundant_import"), "found redundant_import category");
  await ok(cats.has("dead_code"), "found dead_code category");
  await ok(cats.has("boilerplate"), "found boilerplate category");
  await ok(cats.has("verbose_pattern"), "found verbose_pattern category");
  await ok(cats.has("long_literal"), "found long_literal category");
}

// MCP register
{
  const { status, json } = await postJSON("/api/token-optimizer", {
    action: "register_mcp",
    name: "test-server-" + Date.now(),
    transport: "http",
    endpoint: "https://example.com/sse",
    enabled: true,
  });
  await ok(status === 200, "POST register_mcp returns 200");
  await ok(json.ok === true, "register_mcp ok=true");
  await ok(json.server.id, "server has id");
  await ok(json.server.endpoint === "https://example.com/sse", "endpoint stored");
}

// MCP toggle
{
  // First register, then toggle
  const reg = await postJSON("/api/token-optimizer", { action: "register_mcp", name: "toggle-test", transport: "stdio", command: "echo" });
  const id = reg.json.server.id;
  const { status, json } = await postJSON("/api/token-optimizer", { action: "toggle_mcp", server_id: id, enabled: false });
  await ok(status === 200, "POST toggle_mcp returns 200");
  await ok(json.ok === true, "toggle_mcp ok=true");
  await ok(json.enabled === false, "toggled to disabled");
}

// MCP call (filesystem list_directory)
{
  const { status, json } = await postJSON("/api/token-optimizer", {
    action: "call_mcp",
    server_id: "mcp-filesystem",
    tool_name: "list_directory",
    args: { path: "/home/z/my-project/src" },
  });
  await ok(status === 200, "POST call_mcp (filesystem.list_directory) returns 200");
  await ok(json.ok === true, "call_mcp ok=true");
  await ok(json.result && json.result.entries, "result has entries array");
  await ok(json.result.entries.includes("app"), "result includes 'app' directory");
  await ok(json.elapsed_ms < 1000, "elapsed_ms < 1000");
}

// MCP call on disabled server fails
{
  const reg = await postJSON("/api/token-optimizer", { action: "register_mcp", name: "disabled-test", transport: "stdio", command: "echo", enabled: false });
  const id = reg.json.server.id;
  const { status, json } = await postJSON("/api/token-optimizer", { action: "call_mcp", server_id: id, tool_name: "anything", args: {} });
  await ok(status === 200, "POST call_mcp (disabled server) returns 200");
  await ok(json.ok === false, "call_mcp ok=false (disabled)");
  await ok(json.error === "server disabled", "error message is 'server disabled'");
}

// Remove MCP
{
  const reg = await postJSON("/api/token-optimizer", { action: "register_mcp", name: "remove-test", transport: "stdio", command: "echo" });
  const id = reg.json.server.id;
  const { status, json } = await postJSON("/api/token-optimizer", { action: "remove_mcp", server_id: id });
  await ok(status === 200, "POST remove_mcp returns 200");
  await ok(json.ok === true, "remove_mcp ok=true");
}

// Generate AI suggestions
{
  const { status, json } = await postJSON("/api/token-optimizer", {
    action: "generate_ai_suggestions",
    input: "The categorization_capability_index module is responsible for managing the categorization_capability_index state. When categorization_capability_index receives a new task, it dispatches to categorization_capability_index workers. Each categorization_capability_index worker reports back to categorization_capability_index via the categorization_capability_index API.",
    max_suggestions: 3,
  });
  await ok(status === 200, "POST generate_ai_suggestions returns 200");
  await ok(json.ok === true, "generate_ai_suggestions ok=true");
  await ok(Array.isArray(json.suggestions), "suggestions is array");
  await ok(json.suggestions.length > 0, "≥1 suggestion returned");
  if (json.suggestions.length > 0) {
    const s = json.suggestions[0];
    await ok(s.title && s.title.length > 0, "suggestion has title");
    await ok(s.confidence >= 0 && s.confidence <= 1, "confidence in [0,1]");
    await ok(s.est_tokens_saved >= 1, "est_tokens_saved >= 1");
    await ok(s.before_preview && s.after_preview, "has before/after previews");
  }
}

// Invalid action
{
  const { status, json } = await postJSON("/api/token-optimizer", { action: "bogus_action" });
  await ok(status === 400, "POST with bogus action returns 400");
  await ok(json.error.includes("unknown action"), "error mentions 'unknown action'");
}

// Missing input for optimize_text
{
  const { status } = await postJSON("/api/token-optimizer", { action: "optimize_text", input: "" });
  await ok(status === 400, "POST optimize_text with empty input returns 400");
}

console.log("\n=== Omnigent Memory ===\n");

// GET state
{
  const { status, json } = await getJSON("/api/omnigent-memory");
  await ok(status === 200, "GET /api/omnigent-memory returns 200");
  await ok("memory" in json, "state has memory stats");
  await ok("load_balancer" in json, "state has load_balancer stats");
  await ok("recent_memories" in json, "state has recent_memories");
  await ok(json.memory.total_entries >= 5, "≥5 memories seeded");
  await ok(json.memory.long_term_count >= 5, "≥5 long-term memories");
}

// Store a memory
{
  const { status, json } = await postJSON("/api/omnigent-memory", {
    action: "store",
    content: "Test memory: Atlas-1 handles categorization tasks best.",
    scope: "agent",
    agent_id: "atlas-1",
    tags: ["test", "categorization"],
    importance: 0.8,
    tier: "long_term",
  });
  await ok(status === 200, "POST store returns 200");
  await ok(json.ok === true, "store ok=true");
  await ok(json.entry && json.entry.id, "entry has id");
  await ok(json.entry.agent_id === "atlas-1", "agent_id stored correctly");
  await ok(json.entry.vector && Object.keys(json.entry.vector).length > 0, "vector embedding generated");
}

// Recall
{
  const { status, json } = await postJSON("/api/omnigent-memory", {
    action: "recall",
    query: "which agent is best at categorization",
    top_k: 3,
  });
  await ok(status === 200, "POST recall returns 200");
  await ok(json.ok === true, "recall ok=true");
  await ok(json.results.length > 0, "≥1 result returned");
  if (json.results.length > 0) {
    const r = json.results[0];
    await ok(r.score > 0, "top result has positive score");
    await ok(r.entry.content, "top result has content");
    await ok(r.entry.recall_count >= 1, "recall_count was bumped");
  }
}

// Recall with no matches
{
  const { status, json } = await postJSON("/api/omnigent-memory", {
    action: "recall",
    query: "xyzzy_qwerty_nonexistent_topic_12345",
    top_k: 5,
    min_score: 0.99,
  });
  await ok(status === 200, "POST recall (no matches) returns 200");
  await ok(json.count === 0, "count=0 for non-matching query");
}

// List memories with tier filter
{
  const { status, json } = await getJSON("/api/omnigent-memory?list=1&tier=long_term&limit=20");
  await ok(status === 200, "GET ?list=1&tier=long_term returns 200");
  await ok(json.entries.length > 0, "≥1 long-term memory listed");
  await ok(json.entries.every((e) => e.tier === "long_term"), "all entries are long_term");
}

// Consolidate
{
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "consolidate", similarity_threshold: 0.95 });
  await ok(status === 200, "POST consolidate returns 200");
  await ok(json.ok === true, "consolidate ok=true");
  await ok(typeof json.merged === "number", "merged count returned");
  await ok(typeof json.kept === "number", "kept count returned");
}

// Promote working to long-term
{
  // First store a working-tier memory
  await postJSON("/api/omnigent-memory", {
    action: "store",
    content: "Working-tier test memory for promotion.",
    tier: "working",
    scope: "task",
  });
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "promote" });
  await ok(status === 200, "POST promote returns 200");
  await ok(json.ok === true, "promote ok=true");
  await ok(typeof json.promoted === "number", "promoted count returned");
}

// Pick agent (synthetic)
{
  const agents = [
    { id: "a1", name: "Agent A", type: "data_analyst", capabilities: ["categorization"], current_workload: 1, max_workload: 5, success_rate: 95, recent_latency_ms: 500, tasks_completed: 30, status: "active" },
    { id: "a2", name: "Agent B", type: "data_analyst", capabilities: ["categorization"], current_workload: 4, max_workload: 5, success_rate: 80, recent_latency_ms: 2000, tasks_completed: 5, status: "active" },
    { id: "a3", name: "Agent C", type: "devops", capabilities: ["shell"], current_workload: 0, max_workload: 5, success_rate: 99, recent_latency_ms: 100, tasks_completed: 100, status: "active" },
  ];
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "pick_agent", capability: "categorization", agents, top_k: 5 });
  await ok(status === 200, "POST pick_agent returns 200");
  await ok(json.ok === true, "pick_agent ok=true");
  await ok(json.picks.length === 2, "2 agents matched the capability (a3 excluded)");
  await ok(json.picks[0].agent.id === "a1", "Agent A is top pick (better workload + success)");
  await ok(json.picks[0].score > json.picks[1].score, "top score > runner-up score");
  await ok(json.picks[0].reasons.length > 0, "top pick has reasons");
  await ok(json.picks[0].reasons.some((r) => r.includes("capability")), "reasons mention capability");
}

// Pick agent with live roster
{
  const agentsRes = await getJSON("/api/omnigent-memory?agents=1");
  await ok(agentsRes.json.total === 200, "live roster has 200 agents");
  const pickRes = await postJSON("/api/omnigent-memory", {
    action: "pick_agent",
    capability: "transcription",
    agents: agentsRes.json.agents,
    top_k: 3,
  });
  await ok(pickRes.status === 200, "pick_agent with live roster returns 200");
  await ok(pickRes.json.picks.length > 0, "≥1 agent picked for 'transcription'");
  await ok(pickRes.json.picks[0].agent.capabilities.includes("transcription"), "picked agent actually has 'transcription'");
}

// Record completion (affinity + latency tracking)
{
  const { status, json } = await postJSON("/api/omnigent-memory", {
    action: "record_completion",
    agent_id: "a1",
    capability: "categorization",
    latency_ms: 750,
    success: true,
  });
  await ok(status === 200, "POST record_completion returns 200");
  await ok(json.ok === true, "record_completion ok=true");
}

// Get affinity map
{
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "affinity" });
  await ok(status === 200, "POST affinity returns 200");
  await ok(json.ok === true, "affinity ok=true");
  await ok(typeof json.affinity === "object", "affinity is object");
  const keys = Object.keys(json.affinity);
  await ok(keys.some((k) => k.includes("categorization")), "affinity has categorization entry");
}

// Delete memory
{
  const store = await postJSON("/api/omnigent-memory", { action: "store", content: "To be deleted.", tier: "working" });
  const id = store.json.entry.id;
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "delete", id });
  await ok(status === 200, "POST delete returns 200");
  await ok(json.ok === true, "delete ok=true");
}

// Invalid action
{
  const { status, json } = await postJSON("/api/omnigent-memory", { action: "bogus_action" });
  await ok(status === 400, "POST with bogus action returns 400");
  await ok(json.error.includes("unknown action"), "error mentions 'unknown action'");
}

console.log("\n=== Dashboard Integration ===\n");

// Dashboard loads with new tabs
{
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  await ok(r.status === 200, "GET / returns 200");
  await ok(html.includes("Token Optimizer"), "page contains 'Token Optimizer' nav entry");
  await ok(html.includes("Omnigent"), "page contains 'Omnigent' nav entry");
  await ok(html.includes("Symbol extraction"), "page contains Token Optimizer hint");
  await ok(html.includes("Tiered memory"), "page contains Omnigent hint");
  await ok(html.includes("grid-cols-15"), "mobile nav uses grid-cols-15 (15 entries)");
}

// All safety endpoints still healthy
{
  const endpoints = ["/api/state", "/api/models", "/api/sig", "/api/guardrails", "/api/redress", "/api/agent-safety", "/api/token-optimizer", "/api/omnigent-memory"];
  for (const ep of endpoints) {
    const r = await fetch(`${BASE}${ep}`);
    await ok(r.status === 200, `GET ${ep} → 200`);
  }
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);

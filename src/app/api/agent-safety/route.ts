/**
 * GET /api/agent-safety
 *
 * Returns the current Agent Safety Bindings (ASB) state:
 *   - bindings (62 capability → required guardrails)
 *   - categories (7 categories with enforcement policies)
 *   - pinned_guardrails (operator-pinned, cannot disable)
 *   - manually_disabled_bindings (operator-disabled capability bindings)
 *   - gate_evaluations (per-agent counters)
 *   - last_audit_at + last_audit_findings (last coverage audit)
 *
 * Query params:
 *   ?audit=1           — run a fresh coverage audit across all agents in DB
 *   ?findings=1        — include last audit findings in response
 *
 * POST /api/agent-safety
 * Body: { action, ... }
 *
 *   { action: "pin_guardrail", id: "<guardrail_id>" }
 *     Pin a guardrail so it cannot be disabled while any agent uses its
 *     bound capabilities. Force-enables it in SGR if it was disabled.
 *
 *   { action: "unpin_guardrail", id: "<guardrail_id>" }
 *     Remove the pin.
 *
 *   { action: "disable_binding", capability: "<capability>" }
 *     Manually disable a capability binding — the gate will skip checking
 *     guardrails for this capability. Use when an operator has explicitly
 *     decided to accept the risk for a capability.
 *
 *   { action: "enable_binding", capability: "<capability>" }
 *     Re-enable a previously disabled capability binding.
 *
 *   { action: "run_audit" }
 *     Run a fresh coverage audit across all agents in DB. Stores the result
 *     in ASB state and returns the findings.
 *
 *   { action: "clear_evaluations" }
 *     Reset all per-agent gate evaluation counters.
 *
 *   { action: "can_disable_guardrail", id: "<guardrail_id>" }
 *     Check whether a guardrail can be disabled (i.e., not pinned). Returns
 *     { ok: true } or { ok: false, reason: "..." }.
 */

import { NextResponse } from "next/server";
import {
  getAsbState,
  getCoverageStats,
  getAuditFindings,
  runCoverageAudit,
  pinGuardrail,
  unpinGuardrail,
  disableBinding,
  enableBinding,
  clearGateEvaluations,
  canDisableGuardrail,
  getAllBindings,
  getAllCategoryPolicies,
} from "@/lib/agent-safety-bindings";
import { b44 } from "@/lib/base44";
import type { Agent } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeFindings = url.searchParams.get("findings") === "1";
  const runFreshAudit = url.searchParams.get("audit") === "1";

  const state = getAsbState();
  const stats = getCoverageStats();
  const response: Record<string, unknown> = {
    ...state,
    stats,
    bindings_list: getAllBindings(),
    categories_list: getAllCategoryPolicies(),
  };

  if (includeFindings) {
    response.findings = getAuditFindings();
  }

  if (runFreshAudit) {
    try {
      const agents = (await b44.list("Agent", {
        q: { status: "active" },
        limit: 200,
      })) as Agent[];
      const findings = runCoverageAudit(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          capabilities: a.capabilities || [],
        }))
      );
      response.fresh_audit = {
        ran_at: new Date().toISOString(),
        agent_count: agents.length,
        findings_count: findings.length,
        critical_count: findings.filter((f) => f.severity === "critical").length,
        warning_count: findings.filter((f) => f.severity === "warning").length,
        info_count: findings.filter((f) => f.severity === "info").length,
        findings,
      };
    } catch (err) {
      response.fresh_audit_error =
        err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    id?: string;
    capability?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = body.action;

  if (action === "pin_guardrail") {
    if (!body.id) {
      return NextResponse.json(
        { error: "id is required for pin_guardrail" },
        { status: 400 }
      );
    }
    pinGuardrail(body.id);
    return NextResponse.json({ ok: true, action, id: body.id });
  }

  if (action === "unpin_guardrail") {
    if (!body.id) {
      return NextResponse.json(
        { error: "id is required for unpin_guardrail" },
        { status: 400 }
      );
    }
    unpinGuardrail(body.id);
    return NextResponse.json({ ok: true, action, id: body.id });
  }

  if (action === "disable_binding") {
    if (!body.capability) {
      return NextResponse.json(
        { error: "capability is required for disable_binding" },
        { status: 400 }
      );
    }
    disableBinding(body.capability);
    return NextResponse.json({ ok: true, action, capability: body.capability });
  }

  if (action === "enable_binding") {
    if (!body.capability) {
      return NextResponse.json(
        { error: "capability is required for enable_binding" },
        { status: 400 }
      );
    }
    enableBinding(body.capability);
    return NextResponse.json({ ok: true, action, capability: body.capability });
  }

  if (action === "run_audit") {
    try {
      const agents = (await b44.list("Agent", {
        q: { status: "active" },
        limit: 200,
      })) as Agent[];
      const findings = runCoverageAudit(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          capabilities: a.capabilities || [],
        }))
      );
      return NextResponse.json({
        ok: true,
        action,
        ran_at: new Date().toISOString(),
        agent_count: agents.length,
        findings_count: findings.length,
        critical_count: findings.filter((f) => f.severity === "critical").length,
        warning_count: findings.filter((f) => f.severity === "warning").length,
        info_count: findings.filter((f) => f.severity === "info").length,
        findings,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 500 }
      );
    }
  }

  if (action === "clear_evaluations") {
    clearGateEvaluations();
    return NextResponse.json({ ok: true, action });
  }

  if (action === "can_disable_guardrail") {
    if (!body.id) {
      return NextResponse.json(
        { error: "id is required for can_disable_guardrail" },
        { status: 400 }
      );
    }
    const result = canDisableGuardrail(body.id);
    return NextResponse.json({ action, id: body.id, ...result });
  }

  return NextResponse.json(
    { error: `unknown action: ${action}` },
    { status: 400 }
  );
}

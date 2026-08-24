import { NextResponse } from "next/server";
import {
  getOmnigentState,
  storeMemory,
  recallMemories,
  consolidateMemories,
  promoteWorkingToLongTerm,
  listMemories,
  deleteMemory,
  clearMemory,
  pickAgent,
  recordAgentCompletion,
  getAffinityMap,
  getAgentLatency,
  seedDemoMemories,
  type AgentLoadInfo,
} from "@/lib/omnigent-memory";
import { b44, type Agent } from "@/lib/base44";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/omnigent-memory
 *   Returns the current omnigent state: memory stats, load balancer stats,
 *   recent memories, affinity count.
 *
 * GET /api/omnigent-memory?list=1&tier=long_term&limit=50
 *   Returns a paginated list of memories.
 *
 * GET /api/omnigent-memory?agents=1
 *   Returns the live agent roster from Base44 (used by the load balancer UI).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const list = url.searchParams.get("list");
  const agents = url.searchParams.get("agents");

  if (list === "1") {
    const tier = url.searchParams.get("tier") as "working" | "long_term" | null;
    const scope = url.searchParams.get("scope") as "task" | "mission" | "agent" | "global" | null;
    const agentId = url.searchParams.get("agent_id");
    const limit = Number(url.searchParams.get("limit") || 50);
    const offset = Number(url.searchParams.get("offset") || 0);
    const result = listMemories({
      tier: tier || undefined,
      scope: scope || undefined,
      agent_id: agentId || undefined,
      limit,
      offset,
    });
    return NextResponse.json(result);
  }

  if (agents === "1") {
    try {
      const raw = (await b44.list("Agent", { limit: 200 })) as Agent[];
      const agentLoadInfos: AgentLoadInfo[] = raw.map((a) => ({
        id: a.id || a.name,
        name: a.name,
        type: a.type,
        capabilities: a.capabilities || [],
        current_workload: Number(a.current_workload || 0),
        max_workload: Number(a.max_workload || 5),
        success_rate: Number(a.performance_metrics?.success_rate || 100),
        recent_latency_ms: 0,
        tasks_completed: Number(a.performance_metrics?.tasks_completed || 0),
        status: (a.status as AgentLoadInfo["status"]) || "active",
      }));
      return NextResponse.json({ total: agentLoadInfos.length, agents: agentLoadInfos });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message, total: 0, agents: [] }, { status: 500 });
    }
  }

  // Seed demo memories on first call so the UI has content
  seedDemoMemories();
  return NextResponse.json(getOmnigentState());
}

/**
 * POST /api/omnigent-memory
 *   Body: { action: string, ...payload }
 *
 * Supported actions:
 *   store        — { content, scope?, agent_id?, task_id?, mission_id?, tags?, importance?, tier?, metadata? }
 *   recall       — { query, top_k?, scope?, agent_id?, tier?, tags?, min_score? }
 *   consolidate  — { similarity_threshold?, max_batch? }
 *   promote      — {}  promote working-tier entries with ≥2 recalls to long_term
 *   delete       — { id }
 *   clear        — { tier? }
 *   pick_agent   — { agents, capability, mission_id?, task_type?, top_k? }
 *   record_completion — { agent_id, capability, latency_ms?, success? }
 *   seed         — {}  seed demo memories if empty
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  try {
    switch (action) {
      case "store": {
        const content = String(body.content || "");
        if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });
        const entry = storeMemory(content, {
          scope: (body.scope as "task" | "mission" | "agent" | "global") || undefined,
          agent_id: body.agent_id != null ? String(body.agent_id) : null,
          task_id: body.task_id != null ? String(body.task_id) : null,
          mission_id: body.mission_id != null ? String(body.mission_id) : null,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          importance: body.importance != null ? Number(body.importance) : undefined,
          tier: (body.tier as "working" | "long_term") || undefined,
          metadata: body.metadata as Record<string, unknown> | undefined,
        });
        return NextResponse.json({ ok: true, entry });
      }
      case "recall": {
        const query = String(body.query || "");
        if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });
        // Only pass agent_id/task_id/mission_id if the caller actually
        // provided them — otherwise we'd filter for null and exclude all
        // agent-scoped memories.
        const recallOpts: Parameters<typeof recallMemories>[0] = {
          query,
          top_k: body.top_k ? Number(body.top_k) : undefined,
          scope: (body.scope as "task" | "mission" | "agent" | "global") || undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          tier: (body.tier as "working" | "long_term") || undefined,
          min_score: body.min_score != null ? Number(body.min_score) : undefined,
        };
        if (body.agent_id != null) recallOpts.agent_id = String(body.agent_id);
        if (body.task_id != null) recallOpts.task_id = String(body.task_id);
        if (body.mission_id != null) recallOpts.mission_id = String(body.mission_id);
        const results = recallMemories(recallOpts);
        return NextResponse.json({ ok: true, results, count: results.length });
      }
      case "consolidate": {
        const result = consolidateMemories({
          similarity_threshold: body.similarity_threshold != null ? Number(body.similarity_threshold) : undefined,
          max_batch: body.max_batch != null ? Number(body.max_batch) : undefined,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "promote": {
        const promoted = promoteWorkingToLongTerm();
        return NextResponse.json({ ok: true, promoted });
      }
      case "delete": {
        const id = String(body.id || "");
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        const ok = deleteMemory(id);
        return NextResponse.json({ ok, id });
      }
      case "clear": {
        const tier = (body.tier as "working" | "long_term") || undefined;
        const removed = clearMemory({ tier });
        return NextResponse.json({ ok: true, removed });
      }
      case "pick_agent": {
        const agentsIn = Array.isArray(body.agents) ? (body.agents as AgentLoadInfo[]) : [];
        const capability = String(body.capability || "");
        if (!capability) return NextResponse.json({ error: "capability required" }, { status: 400 });
        if (agentsIn.length === 0) return NextResponse.json({ error: "agents array required" }, { status: 400 });
        const picks = pickAgent(agentsIn, capability, {
          mission_id: body.mission_id ? String(body.mission_id) : undefined,
          task_type: body.task_type ? String(body.task_type) : undefined,
          top_k: body.top_k ? Number(body.top_k) : undefined,
        });
        return NextResponse.json({ ok: true, picks, count: picks.length });
      }
      case "record_completion": {
        const agentId = String(body.agent_id || "");
        const capability = String(body.capability || "");
        if (!agentId || !capability) {
          return NextResponse.json({ error: "agent_id and capability required" }, { status: 400 });
        }
        recordAgentCompletion(agentId, capability, {
          latency_ms: body.latency_ms != null ? Number(body.latency_ms) : undefined,
          success: body.success !== false,
        });
        return NextResponse.json({ ok: true });
      }
      case "seed": {
        seedDemoMemories();
        return NextResponse.json({ ok: true, state: getOmnigentState() });
      }
      case "affinity": {
        return NextResponse.json({ ok: true, affinity: getAffinityMap() });
      }
      case "latency": {
        const agentId = String(body.agent_id || "");
        if (!agentId) return NextResponse.json({ error: "agent_id required" }, { status: 400 });
        return NextResponse.json({ ok: true, agent_id: agentId, ...getAgentLatency(agentId) });
      }
      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "internal error", action },
      { status: 500 }
    );
  }
}

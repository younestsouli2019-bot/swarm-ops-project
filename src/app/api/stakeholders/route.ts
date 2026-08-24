import { NextRequest, NextResponse } from "next/server";
import { b44, type Agent } from "@/lib/base44";
import {
  buildStakeholderRegistry,
  classifyAgent,
  findHandoffRecommendations,
  type StakeholderClass,
  type LifecycleState,
} from "@/lib/agentic-stakeholders";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/stakeholders
 *   Returns the full Agentic Stakeholder Registry snapshot.
 *
 * Query params:
 *   ?class=worker         — filter to a single stakeholder class
 *   ?lifecycle=saturated  — filter to a single lifecycle state
 *   ?agent_id=<id>        — drill down to a single agent's classification
 *   ?limit=50             — cap workers/operators arrays (default 50)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const classFilter = url.searchParams.get("class") as
      | StakeholderClass
      | null;
    const lifecycleFilter = url.searchParams.get("lifecycle") as
      | LifecycleState
      | null;
    const agentId = url.searchParams.get("agent_id");
    const limitParam = Number(url.searchParams.get("limit") || "50");
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitParam) ? limitParam : 50));

    // Single-agent drill-down.
    if (agentId) {
      const agents = (await b44.list("Agent", {
        q: { id: agentId },
        limit: 1,
      })) as Agent[];
      if (agents.length === 0 || !agents[0]) {
        return NextResponse.json(
          { error: `Agent ${agentId} not found` },
          { status: 404 },
        );
      }
      const classification = classifyAgent(agents[0]);
      return NextResponse.json({
        agent: agents[0],
        classification,
      });
    }

    // Full registry.
    const agents = (await b44.list("Agent", { limit: 500 })) as Agent[];
    const registry = buildStakeholderRegistry(agents);

    // Apply filters if specified.
    let filteredWorkers = registry.workers;
    let filteredOperators = registry.operators;
    let filteredQuarantined = registry.quarantined;
    if (classFilter) {
      if (classFilter !== "worker") filteredWorkers = [];
      if (classFilter !== "operator") filteredOperators = [];
      if (classFilter !== "quarantined") filteredQuarantined = [];
    }
    if (lifecycleFilter) {
      filteredWorkers = filteredWorkers.filter(
        (c) => c.lifecycle === lifecycleFilter,
      );
      filteredOperators = filteredOperators.filter(
        (c) => c.lifecycle === lifecycleFilter,
      );
      filteredQuarantined = filteredQuarantined.filter(
        (c) => c.lifecycle === lifecycleFilter,
      );
    }

    // Pre-compute handoff recommendations so the dashboard can preview them
    // without a separate /rebalance call.
    const recommendations = findHandoffRecommendations(registry, 10);

    return NextResponse.json({
      generated_at: registry.generated_at,
      summary: {
        total_entities: registry.total_entities,
        by_class: registry.by_class,
        by_lifecycle: registry.by_lifecycle,
        by_catalog_source: registry.by_catalog_source,
        avg_health_score: registry.avg_health_score,
        unrealized_capacity_estimate_usd: registry.unrealized_capacity_estimate_usd,
        saturated_workers_count: registry.saturated_workers.length,
        idle_workers_count: registry.idle_workers.length,
      },
      workers: filteredWorkers.slice(0, limit),
      operators: filteredOperators.slice(0, limit),
      quarantined: filteredQuarantined.slice(0, limit),
      top_performers: registry.top_performers,
      catalog_sample: registry.catalog_sample,
      saturated_workers: registry.saturated_workers,
      idle_workers: registry.idle_workers,
      handoff_recommendations: recommendations,
      policy: {
        classification_rules:
          "worker = Noun-N name + capabilities; operator = operator-tier name; catalog = marketplace listing name; quarantined = stale > 30d + success_rate < 50% + 0 tasks",
        health_score_weights: {
          success_rate: 0.4,
          activity_recency: 0.25,
          tasks_quintile: 0.2,
          workload_balance: 0.15,
        },
        lifecycle_rules:
          "quarantined > retired (>180d) > stale (>90d) > saturated (>=max) > idle (0) > active",
        handoff_policy:
          "auto-routes from saturated workers (current>=max) to idle workers (0/n) with overlapping capabilities, max 3 per tick",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

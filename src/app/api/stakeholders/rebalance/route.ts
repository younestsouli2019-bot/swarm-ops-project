import { NextRequest, NextResponse } from "next/server";
import { b44, type Agent } from "@/lib/base44";
import {
  buildStakeholderRegistry,
  findHandoffRecommendations,
  activateHandoffs,
  type HandoffRecommendation,
} from "@/lib/agentic-stakeholders";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/stakeholders/rebalance
 *
 * Triggers a stakeholder rebalance: scan the swarm, find saturated workers
 * with eligible idle matches, and materialize handoffs (up to max_handoffs).
 *
 * Body (all optional):
 *   { "max_handoffs": 3, "max_recommendations": 10, "dry_run": false }
 *
 * If dry_run=true, returns the recommendations WITHOUT creating any
 * AgentHandoff records. Default is dry_run=false (real handoffs).
 *
 * Returns:
 *   {
 *     "dry_run": boolean,
 *     "recommendations": HandoffRecommendation[],
 *     "activations": HandoffActivationResult | null,
 *     "summary": { ... }
 *   }
 */
export async function POST(req: NextRequest) {
  try {
    let body: {
      max_handoffs?: number;
      max_recommendations?: number;
      dry_run?: boolean;
    } = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is fine — use defaults.
      body = {};
    }

    const maxHandoffs = Math.max(0, Math.min(10, Number(body.max_handoffs || 3)));
    const maxRecs = Math.max(1, Math.min(50, Number(body.max_recommendations || 10)));
    const dryRun = body.dry_run === true;

    // Build the registry + recommendations.
    const agents = (await b44.list("Agent", { limit: 500 })) as Agent[];
    const registry = buildStakeholderRegistry(agents);
    const recommendations: HandoffRecommendation[] = findHandoffRecommendations(
      registry,
      maxRecs,
    );

    if (dryRun) {
      return NextResponse.json({
        dry_run: true,
        generated_at: registry.generated_at,
        summary: {
          total_entities: registry.total_entities,
          saturated_workers_count: registry.saturated_workers.length,
          idle_workers_count: registry.idle_workers.length,
          recommendations_generated: recommendations.length,
        },
        recommendations,
        activations: null,
        message: "Dry-run — no handoffs created. Set dry_run=false to execute.",
      });
    }

    // Execute real handoffs.
    const activations = await activateHandoffs(recommendations, maxHandoffs);

    return NextResponse.json({
      dry_run: false,
      generated_at: registry.generated_at,
      summary: {
        total_entities: registry.total_entities,
        saturated_workers_count: registry.saturated_workers.length,
        idle_workers_count: registry.idle_workers.length,
        recommendations_generated: recommendations.length,
        handoffs_created: activations.handoffs_created,
        handoffs_failed: activations.handoffs_failed,
      },
      recommendations,
      activations,
      message:
        activations.handoffs_created > 0
          ? `${activations.handoffs_created} handoff(s) created. View at /api/state (handoffs field).`
          : recommendations.length === 0
            ? "No saturated workers or no eligible idle matches — no handoffs needed."
            : `0 handoffs created (${activations.handoffs_failed} failed). See activations.errors for details.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/stakeholders/rebalance
 *   Returns a preview of handoff recommendations WITHOUT executing them.
 *   Equivalent to POST with dry_run=true but no body needed.
 */
export async function GET() {
  try {
    const agents = (await b44.list("Agent", { limit: 500 })) as Agent[];
    const registry = buildStakeholderRegistry(agents);
    const recommendations = findHandoffRecommendations(registry, 20);

    return NextResponse.json({
      dry_run: true,
      generated_at: registry.generated_at,
      summary: {
        total_entities: registry.total_entities,
        saturated_workers_count: registry.saturated_workers.length,
        idle_workers_count: registry.idle_workers.length,
        recommendations_generated: recommendations.length,
      },
      saturated_workers: registry.saturated_workers,
      idle_workers: registry.idle_workers,
      recommendations,
      message:
        "Dry-run preview. POST to /api/stakeholders/rebalance with {dry_run:false} to execute.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  refreshActivationState,
  activateKey,
  formatEnvFile,
  type KeyActivationPlan,
} from "@/lib/api-key-activation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/models/activate
 *   Returns the current activation snapshot: missing keys, activated keys,
 *   provider health, the 10-site fleet state, routing table, and stats.
 */
export async function GET() {
  try {
    const snapshot = refreshActivationState();
    return NextResponse.json({
      generated_at: snapshot.generated_at,
      summary: {
        total_models: snapshot.total_models,
        available_models: snapshot.available_models,
        keys_activated: snapshot.activated_keys.length,
        keys_pending: snapshot.missing_keys.length,
        auto_activation_enabled: snapshot.auto_activation_enabled,
        sites_active: snapshot.sites.filter((s) => s.status === "active").length,
        sites_total: snapshot.sites.length,
      },
      missing_keys: snapshot.missing_keys,
      activated_keys: snapshot.activated_keys.map((p: KeyActivationPlan) => ({
        ...p,
        // Don't expose the actual key value in the API response.
        models_unlocked: p.models_unlocked,
      })),
      provider_health: snapshot.provider_health,
      sites: snapshot.sites,
      routing_table: snapshot.routing_table,
      stats: snapshot.stats,
      env_file_snippet: formatEnvFile(),
      policy: {
        autonomous_activation:
          "Operator provides key value → activateKey() writes to process.env + marks plan activated. Future autonomous flow: headless browser visits portal, scrapes key, writes .env, restarts server.",
        load_balancing_strategy:
          "Round-robin per-provider across active sites, health-weighted (headroom remaining, success rate, context window). Failover to next 2 sites + next 2 providers.",
        site_provisioning:
          "First 2 sites are operator-provided (j13v96vaawp0-d, n1u4v5127m40-deploy). Slots 3-10 are reserved for autonomous spin-up via provisionSite().",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/models/activate
 *   Activate an API key for a provider.
 *
 * Body:
 *   { "env_var": "DEEPSEEK_API_KEY", "key_value": "sk-...", "activated_by": "operator" }
 *
 * In sandbox: writes the key to process.env for the current runtime + marks
 * the plan as activated. The key will NOT persist across dev server restarts
 * unless the operator also adds it to .env (use the env_file_snippet from GET).
 *
 * Returns the ActivationResult.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const envVar = String(body.env_var || "").trim();
    const keyValue = String(body.key_value || "").trim();
    const activatedBy = String(body.activated_by || "operator").trim();

    if (!envVar) {
      return NextResponse.json(
        { error: "env_var is required (e.g. DEEPSEEK_API_KEY)" },
        { status: 400 },
      );
    }
    if (!keyValue) {
      return NextResponse.json(
        { error: "key_value is required" },
        { status: 400 },
      );
    }

    const result = activateKey(envVar, keyValue, activatedBy);
    return NextResponse.json({
      result,
      snapshot: refreshActivationState(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

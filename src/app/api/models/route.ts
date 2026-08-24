import { NextResponse } from "next/server";
import { FREE_MODELS, getAvailableModels, getDefaultModel } from "@/lib/free-models";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/models
 *
 * Returns the registry of free-tier AI models the swarm can use for
 * inference, plus which ones are currently available given the env vars
 * that are set.
 */
export async function GET() {
  const available = getAvailableModels();
  const defaultModel = getDefaultModel();

  return NextResponse.json({
    total: FREE_MODELS.length,
    available: available.length,
    default: defaultModel
      ? {
          id: defaultModel.id,
          display_name: defaultModel.display_name,
          provider: defaultModel.provider,
        }
      : null,
    models: FREE_MODELS.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      provider: m.provider,
      model_id: m.model_id,
      context_window: m.context_window,
      capabilities: m.capabilities,
      free_tier_limit: m.free_tier_limit,
      docs_url: m.docs_url,
      available: available.some((a) => a.id === m.id),
      api_key_env: m.api_key_env,
      endpoint: m.endpoint,
    })),
  });
}

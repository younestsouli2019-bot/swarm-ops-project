import { NextResponse } from "next/server";
import {
  getTokenOptimizerState,
  actionOptimizeText,
  actionAnalyzeCode,
  actionRegisterMcp,
  actionToggleMcp,
  actionRemoveMcp,
  actionCallMcp,
  actionGenerateAiSuggestions,
  actionApplyAiSuggestion,
  actionDismissAiSuggestion,
  actionResetStats,
  actionEstimateTokens,
} from "@/lib/token-optimizer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/token-optimizer
 *   Returns the current optimizer state: optimization history, MCP servers,
 *   AI suggestions, and aggregate stats.
 *
 * GET /api/token-optimizer?estimate=<text>
 *   Returns the estimated token count for the given text.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const estimate = url.searchParams.get("estimate");
  if (estimate !== null) {
    const modelId = url.searchParams.get("model_id") || undefined;
    return NextResponse.json({
      text_length: estimate.length,
      estimated_tokens: actionEstimateTokens(estimate, modelId),
      model_id: modelId || "default",
    });
  }
  return NextResponse.json(getTokenOptimizerState());
}

/**
 * POST /api/token-optimizer
 *   Body: { action: string, ...payload }
 *
 * Supported actions:
 *   optimize_text        — { input, extract_symbols?, prune_stop_words?, trim_whitespace?, model_id? }
 *   analyze_code         — { code, model_id?, generate_preview? }
 *   register_mcp         — { id?, name, transport, endpoint?, command?, args?, env?, enabled?, tools? }
 *   toggle_mcp           — { server_id, enabled }
 *   remove_mcp           — { server_id }
 *   call_mcp             — { server_id, tool_name, args }
 *   generate_ai_suggestions — { input, model_id?, max_suggestions? }
 *   apply_ai_suggestion  — { suggestion_id }
 *   dismiss_ai_suggestion — { suggestion_id }
 *   reset_stats          — {}
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
      case "optimize_text": {
        const input = String(body.input || "");
        if (!input) return NextResponse.json({ error: "input required" }, { status: 400 });
        const result = actionOptimizeText(input, {
          extract_symbols: body.extract_symbols !== false,
          prune_stop_words: body.prune_stop_words === true,
          trim_whitespace: body.trim_whitespace !== false,
          model_id: body.model_id ? String(body.model_id) : undefined,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "analyze_code": {
        const code = String(body.code || "");
        if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });
        const result = actionAnalyzeCode(code, {
          model_id: body.model_id ? String(body.model_id) : undefined,
          generate_preview: body.generate_preview === true,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "register_mcp": {
        const name = String(body.name || "");
        if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
        const server = actionRegisterMcp({
          id: body.id ? String(body.id) : undefined,
          name,
          transport: (body.transport as "stdio" | "http" | "sse") || "stdio",
          endpoint: body.endpoint ? String(body.endpoint) : undefined,
          command: body.command ? String(body.command) : undefined,
          args: Array.isArray(body.args) ? body.args.map(String) : undefined,
          env: body.env as Record<string, string> | undefined,
          enabled: body.enabled !== false,
          tools: Array.isArray(body.tools) ? body.tools as never : undefined,
        });
        return NextResponse.json({ ok: true, server });
      }
      case "toggle_mcp": {
        const serverId = String(body.server_id || "");
        if (!serverId) return NextResponse.json({ error: "server_id required" }, { status: 400 });
        const enabled = Boolean(body.enabled);
        const ok = actionToggleMcp(serverId, enabled);
        return NextResponse.json({ ok, server_id: serverId, enabled });
      }
      case "remove_mcp": {
        const serverId = String(body.server_id || "");
        if (!serverId) return NextResponse.json({ error: "server_id required" }, { status: 400 });
        const ok = actionRemoveMcp(serverId);
        return NextResponse.json({ ok, server_id: serverId });
      }
      case "call_mcp": {
        const serverId = String(body.server_id || "");
        const toolName = String(body.tool_name || "");
        if (!serverId || !toolName) {
          return NextResponse.json({ error: "server_id and tool_name required" }, { status: 400 });
        }
        const args = (body.args as Record<string, unknown>) || {};
        const result = await actionCallMcp(serverId, toolName, args);
        return NextResponse.json({ ...result });
      }
      case "generate_ai_suggestions": {
        const input = String(body.input || "");
        if (!input) return NextResponse.json({ error: "input required" }, { status: 400 });
        const suggestions = await actionGenerateAiSuggestions(input, {
          model_id: body.model_id ? String(body.model_id) : undefined,
          max_suggestions: body.max_suggestions ? Number(body.max_suggestions) : undefined,
        });
        return NextResponse.json({ ok: true, suggestions });
      }
      case "apply_ai_suggestion": {
        const id = String(body.suggestion_id || "");
        if (!id) return NextResponse.json({ error: "suggestion_id required" }, { status: 400 });
        const ok = actionApplyAiSuggestion(id);
        return NextResponse.json({ ok, suggestion_id: id });
      }
      case "dismiss_ai_suggestion": {
        const id = String(body.suggestion_id || "");
        if (!id) return NextResponse.json({ error: "suggestion_id required" }, { status: 400 });
        const ok = actionDismissAiSuggestion(id);
        return NextResponse.json({ ok, suggestion_id: id });
      }
      case "reset_stats": {
        actionResetStats();
        return NextResponse.json({ ok: true });
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

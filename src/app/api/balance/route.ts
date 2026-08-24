/**
 * GET /api/balance?institution=payoneer
 * GET /api/balance?all=true
 * POST /api/balance { "prompt": "check my payoneer" }
 *
 * Strict balance checking:
 * 1. Intent Router parses prompt → JSON command
 * 2. Deterministic API layer fetches real balances
 * 3. Validation guardrails type-lock + confidence-score
 * 4. Response builder formats for UI — only API data shown
 *
 * 5-minute cache. No AI guessing. No stale data.
 */

import { NextResponse } from "next/server";
import { parseBalanceIntent } from "@/lib/balance/intent-router";
import { fetchBalance, fetchAllBalances, forceRefreshBalance } from "@/lib/balance/api-layer";
import { validateResponse, buildUIPrompt } from "@/lib/balance/validator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const institution = url.searchParams.get("institution");
  const all = url.searchParams.get("all") === "true";
  const force = url.searchParams.get("force") === "true";

  if (all || !institution) {
    const raw = force ? await forceRefreshBalance() : await fetchAllBalances();
    const validated = validateResponse(raw);
    return NextResponse.json({
      ...validated,
      ui: buildUIPrompt(validated),
    });
  }

  const raw = force ? await forceRefreshBalance(institution) : await fetchBalance(institution);
  const validated = validateResponse(raw);
  return NextResponse.json({
    ...validated,
    ui: buildUIPrompt(validated),
  });
}

export async function POST(request: Request) {
  let body: { prompt?: string; institution?: string; force?: boolean };
  try { body = await request.json(); } catch { body = {}; }

  // Intent Router
  const intent = body.prompt
    ? parseBalanceIntent(body.prompt)
    : body.institution
      ? { action: "get_balance" as const, institution: body.institution }
      : { action: "get_all_balances" as const };

  if (intent.action === "ask_clarification") {
    return NextResponse.json({
      ok: false,
      message: "Which account would you like me to check? Available: payoneer, banking_circle, attijariwafa",
      balances: [],
      errors: [],
    });
  }

  if (intent.action === "get_all_balances") {
    const raw = body.force ? await forceRefreshBalance() : await fetchAllBalances();
    const validated = validateResponse(raw);
    return NextResponse.json({
      ...validated,
      intent,
      ui: buildUIPrompt(validated),
    });
  }

  if (intent.action === "get_balance" && intent.institution) {
    const raw = body.force
      ? await forceRefreshBalance(intent.institution)
      : await fetchBalance(intent.institution);
    const validated = validateResponse(raw);
    return NextResponse.json({
      ...validated,
      intent,
      ui: buildUIPrompt(validated),
    });
  }

  return NextResponse.json({
    ok: false,
    message: "Unable to determine what balance to check.",
    balances: [],
    errors: [],
  });
}

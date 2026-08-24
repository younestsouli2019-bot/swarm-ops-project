/**
 * POST /api/payouts/authorize
 *
 * Transition a payout from `validated` → `authorized`.
 *
 * CRITICAL GUARD: autonomous agents CANNOT authorize payouts. The
 * request must come from either:
 *   (a) authorizer_kind: "human_session"  — authorizer_id is the JWT subject
 *   (b) authorizer_kind: "psp_webhook_verified" — authorizer_id is the webhook source
 *
 * This endpoint does NOT call any payment rail. It only records the
 * authorization decision in the append-only event log.
 */

import { NextResponse } from "next/server";
import { authorizePayout } from "@/lib/payout-state-machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: {
    payout_id?: string;
    authorizer_kind?: "human_session" | "psp_webhook_verified" | "autonomous_agent";
    authorizer_id?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.payout_id) {
    return NextResponse.json({ error: "payout_id is required" }, { status: 400 });
  }
  if (!body.authorizer_kind) {
    return NextResponse.json(
      { error: "authorizer_kind is required (human_session | psp_webhook_verified | autonomous_agent)" },
      { status: 400 }
    );
  }
  if (body.authorizer_kind === "autonomous_agent") {
    // Hard refuse — autonomous agents cannot authorize payouts. This is
    // the single most important guard in the entire system.
    return NextResponse.json(
      {
        error:
          "autonomous agents cannot authorize payouts — a human session or a licensed-PSP webhook is required",
        code: "autonomous_authorization_blocked",
      },
      { status: 403 }
    );
  }
  if (!body.authorizer_id) {
    return NextResponse.json(
      { error: `authorizer_id is required for ${body.authorizer_kind}` },
      { status: 400 }
    );
  }

  // NOTE: in a real deployment, this is where we would verify the JWT
  // session (for human_session) or the webhook signature (for
  // psp_webhook_verified) against the request headers. In this sandbox
  // we accept the authorizer_id from the body but log it prominently.
  // A future hardening pass should add real JWT/HMAC verification here.
  const authHeader = request.headers.get("authorization") || "(none)";

  const result = authorizePayout({
    payout_id: body.payout_id,
    actor: `api:${body.authorizer_id}`,
    reason: body.reason || `authorized via ${body.authorizer_kind}`,
    authorizer_kind: body.authorizer_kind,
    authorizer_id: body.authorizer_id,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    payout: result.payout,
    warning:
      "JWT/HMAC verification not yet implemented in this sandbox. " +
      "Before production: verify the Authorization header '" +
      (authHeader.length > 20 ? authHeader.slice(0, 20) + "..." : authHeader) +
      "' against a real session secret or PSP webhook secret.",
  });
}

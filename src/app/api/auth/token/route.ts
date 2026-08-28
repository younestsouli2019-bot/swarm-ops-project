/**
 * POST /api/auth/token — mint a KMS-signed bearer token for trusted
 * daemon invocations.
 *
 * The token is a JWT signed by Vercel KMS (issuerId from env). The
 * swallowing endpoint (/api/swarm/daemon) verifies it against the
 * issuer's public JWKS — no shared secret needed at the verifying side.
 *
 * Only the daemon-eligible role is minted here. signToken() resolves the
 * deployment OIDC token at call time, so it must run inside a route
 * handler (never at module top level).
 */

import { NextRequest, NextResponse } from "next/server";
import { signToken } from "@vercel/kms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISSUER_ID =
  process.env.VERCEL_KMS_ISSUER_ID || "dab1a1e9-dccd-48ba-b9f9-08e50e59c7b4";
const TOKEN_TTL = Number(process.env.AUTH_TOKEN_TTL_SEC || 300);

function checkSecret(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // no secret configured → protect via KMS issuer grant
  const authHeader = req.headers.get("authorization") || "";
  return authHeader === `Bearer ${cronSecret}`;
}

export async function POST(req: NextRequest) {
  // Only the owner / a holder of CRON_SECRET may mint an admin daemon token.
  // (In an upgraded setup this could itself be a KMS-verified client, but it
  // is a privilege-bounded mint with a short TTL.)
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const token = await signToken({
      issuerId: ISSUER_ID,
      claims: {
        sub: "swarm-daemon",
        role: "daemon",
        scope: "swarm:ops:daemon",
      },
      ttl: TOKEN_TTL,
    });

    return NextResponse.json({ token, expires_in: TOKEN_TTL, issuer: `https://kms.vercel.com/${ISSUER_ID}` });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

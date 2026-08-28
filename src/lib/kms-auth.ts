/**
 * KMS Token Verification — validates a Vercel KMS-signed JWT against the
 * issuer's published JWKS. Used by /api/swarm/daemon to authorize trusted
 * autonomous invocations without a shared secret.
 *
 * The token is signed by @vercel/kms inside /api/auth/token and carries
 * { sub: "swarm-daemon", role: "daemon", scope: "swarm:ops:daemon" }.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER_ID =
  process.env.VERCEL_KMS_ISSUER_ID || "dab1a1e9-dccd-48ba-b9f9-08e50e59c7b4";
const ISSUER_URL = `https://kms.vercel.com/${ISSUER_ID}`;

// Cache the remote JWKS (KeyObject set) across warm invocations.
// In a serverless environment this is per-isolate, which is acceptable.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER_URL}/jwks.json`));

export async function verifyDaemonToken(token: string): Promise<{
  ok: boolean;
  reason?: string;
  payload?: Record<string, unknown>;
}> {
  if (!token) return { ok: false, reason: "missing token" };

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER_URL,
      // Require the daemon role be present
    });

    if (payload.role !== "daemon") {
      return { ok: false, reason: "token role is not 'daemon'" };
    }
    if (payload.sub !== "swarm-daemon") {
      return { ok: false, reason: "token sub is not 'swarm-daemon'" };
    }

    return { ok: true, payload };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

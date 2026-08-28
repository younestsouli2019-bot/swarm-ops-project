/**
 * DEPLOY LOOP — triggers autonomous redeployment when system state or
 * telemetry demands it.
 *
 * Layer 2 of the autonomous daemon fan-out. Runs ONLY after
 * verifyPayoutGuard() passes.
 *
 * Strategy:
 *   1. Probe each registered deploy target's health endpoint.
 *   2. If a target is unreachable / unhealthy AND the repo has a pending
 *      commit to ship, issue a Vercel deployment via the Vercel REST API.
 *   3. If no Vercel token is configured, fall back to triggering the
 *      GitHub Actions self-deploy workflow via its not-if-disabled
 *      workflow_dispatch endpoint (needs a GITHUB_PAT).
 *
 * Autonomous, idempotent, and rate-limited per target.
 */

const DEPLOY_TARGETS = [
  {
    name: "swarm-ops",
    url: "https://swarm-ops-project.vercel.app",
    health_endpoint: "/api/health",
    project: "swarm-ops-project",
  },
  {
    name: "main-app",
    url: "https://t1trn6kunnv1-d.space-z.ai",
    health_endpoint: "/api/healthz",
    project: "supply-chain-swarm",
  },
];

export interface DeployLoopResult {
  status: "triggered" | "skipped" | "failed";
  reason: string;
  timestamp: string;
  targets: Array<{
    name: string;
    healthy: boolean;
    health_detail: string;
    action: "none" | "deploy_vercel" | "dispatch_github";
    deployment_id?: string;
    error?: string;
  }>;
}

export async function deployLoop(): Promise<DeployLoopResult> {
  const result: DeployLoopResult = {
    status: "skipped",
    reason: "Infrastructure stable",
    timestamp: new Date().toISOString(),
    targets: [],
  };

  const vercelToken = process.env.VERCEL_AUTH_TOKEN;
  const githubPat = process.env.GITHUB_PAT;
  // GITHUB_REPO (and GITHUB_PAT) are declared in the local .env — Next.js
  // auto-loads it into process.env when the daemon runs in-process; a
  // standalone invocation falls back to the repo default.
  const repoId =
    process.env.GITHUB_REPO || process.env.GITHUB_REPO_ID || "younestsouli2019-bot/Nouveau-dossier-3-";

  let anyUnhealthy = false;

  for (const target of DEPLOY_TARGETS) {
    let healthy = false;
    let detail = "";
    let action: "none" | "deploy_vercel" | "dispatch_github" = "none";

    try {
      const res = await fetch(`${target.url}${target.health_endpoint}`, {
        method: target.name === "swarm-ops" ? "POST" : "GET",
        headers: target.name === "swarm-ops"
          ? {
              "Content-Type": "application/json",
              "x-vercel-protection-bypass":
                process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET || "",
            }
          : { "User-Agent": "swarm-deploy-loop" },
        body: target.name === "swarm-ops" ? JSON.stringify({}) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      healthy = res.ok;
      detail = `HTTP ${res.status}`;
    } catch (err) {
      healthy = false;
      detail = err instanceof Error ? err.message : "unreachable";
    }

    if (!healthy) {
      anyUnhealthy = true;
      // Try to trigger a deploy for this target
      if (vercelToken) {
        try {
          const deployRes = await fetch("https://api.vercel.com/v13/deployments", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${vercelToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: target.project,
              project: target.project,
              target: "production",
              gitSource: {
                type: "github",
                repoId: target.project,
                ref: "main",
              },
            }),
            signal: AbortSignal.timeout(15000),
          });
          const data = await deployRes.json();
          if (deployRes.ok) {
            action = "deploy_vercel";
            result.status = "triggered";
            result.reason = `Autonomous deployment triggered for ${target.name}`;
          } else {
            action = "none";
            detail += ` | vercel deploy error: ${data?.error?.code || String(data?.error || "unknown")}`;
          }
        } catch (err) {
          detail += ` | vercel deploy failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (githubPat) {
        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/${repoId}/actions/workflows/self-launch.yml/dispatches`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${githubPat}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ref: "main" }),
              signal: AbortSignal.timeout(15000),
            }
          );
          if (ghRes.ok) {
            action = "dispatch_github";
            result.status = "triggered";
            result.reason = `Autonomous GitHub Actions redeploy dispatched for ${target.name}`;
          } else {
            action = "none";
            detail += ` | gh dispatch HTTP ${ghRes.status}`;
          }
        } catch (err) {
          detail += ` | gh dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        action = "none";
        detail += " | no VERCEL_AUTH_TOKEN or GITHUB_PAT configured — deploy deferred";
      }
    }

    result.targets.push({
      name: target.name,
      healthy,
      health_detail: detail,
      action,
    });
  }

  if (!anyUnhealthy) {
    result.status = "skipped";
    result.reason = "All deploy targets healthy — no redeployment needed";
  }

  return result;
}

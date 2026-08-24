import { NextRequest, NextResponse } from "next/server";
import {
  refreshActivationState,
  routeRequest,
  recordRequestResult,
  provisionSite,
  heartbeatSite,
  type RoutingDecision,
} from "@/lib/api-key-activation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/loadbalancer
 *   Returns the full load-balancer state: 10-site fleet, provider health,
 *   routing table, and stats.
 *
 * Query params:
 *   ?route=chat   — preview a routing decision for the given capability
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const capability = url.searchParams.get("route");

    const snapshot = refreshActivationState();

    if (capability) {
      const decision = routeRequest(capability);
      return NextResponse.json({
        generated_at: snapshot.generated_at,
        summary: {
          sites_active: snapshot.sites.filter((s) => s.status === "active").length,
          sites_total: snapshot.sites.length,
          providers_available: snapshot.provider_health.filter((p) => p.has_key).length,
          providers_total: snapshot.provider_health.length,
          total_requests_routed: snapshot.stats.total_requests_routed,
          total_failovers: snapshot.stats.total_failovers,
        },
        sites: snapshot.sites,
        provider_health: snapshot.provider_health,
        routing_table: snapshot.routing_table,
        stats: snapshot.stats,
        preview_route: decision,
      });
    }

    return NextResponse.json({
      generated_at: snapshot.generated_at,
      summary: {
        sites_active: snapshot.sites.filter((s) => s.status === "active").length,
        sites_total: snapshot.sites.length,
        providers_available: snapshot.provider_health.filter((p) => p.has_key).length,
        providers_total: snapshot.provider_health.length,
        total_requests_routed: snapshot.stats.total_requests_routed,
        total_failovers: snapshot.stats.total_failovers,
      },
      sites: snapshot.sites,
      provider_health: snapshot.provider_health,
      routing_table: snapshot.routing_table,
      stats: snapshot.stats,
      policy: {
        strategy: "round-robin + health-weighted",
        failover_chain: "primary site → next 2 active sites → next 2 providers",
        site_recovery: "standby sites with health_score >= 50 are auto-reactivated",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/loadbalancer
 *
 * Actions:
 *   { "action": "route", "capability": "chat" }
 *     Preview + execute a routing decision. Returns the chosen provider + site.
 *
 *   { "action": "record_result", "provider": "deepseek", "site_slot": 1, "success": true }
 *     Record a request result. Updates provider + site health.
 *
 *   { "action": "provision_site", "slot": 3, "url": "https://...", "label": "Site 3" }
 *     Provision a new site slot. Marks it active.
 *
 *   { "action": "heartbeat", "slot": 1 }
 *     Heartbeat a site — updates last_heartbeat_at + reactivates standby sites.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || "");

    switch (action) {
      case "route": {
        const capability = String(body.capability || "chat");
        const decision = routeRequest(capability);
        if (!decision) {
          return NextResponse.json(
            {
              error: `No available provider for capability "${capability}". Activate an API key first at /api/models/activate.`,
            },
            { status: 404 },
          );
        }
        return NextResponse.json({
          decision,
          message: `Routed to ${decision.provider} on site ${decision.site_slot}.`,
        });
      }

      case "record_result": {
        const provider = String(body.provider || "");
        const siteSlot = Number(body.site_slot || 0);
        const success = body.success === true;
        const errorMessage = body.error_message
          ? String(body.error_message)
          : undefined;
        if (!provider || !siteSlot) {
          return NextResponse.json(
            { error: "provider and site_slot are required" },
            { status: 400 },
          );
        }
        // Build a minimal decision for recordRequestResult.
        const decision: RoutingDecision = {
          provider,
          model_id: "",
          endpoint: "",
          api_key_env: "",
          site_slot: siteSlot,
          site_url: null,
          fallback_chain: [],
          reason: "",
        };
        recordRequestResult(decision, success, errorMessage);
        return NextResponse.json({
          recorded: true,
          provider,
          site_slot: siteSlot,
          success,
        });
      }

      case "provision_site": {
        const slot = Number(body.slot || 0);
        const siteUrl = String(body.url || "");
        const label = String(body.label || `Site ${slot}`);
        const provisionedBy = String(body.provisioned_by || "operator");
        if (slot < 1 || slot > 10 || !siteUrl) {
          return NextResponse.json(
            { error: "slot (1-10) and url are required" },
            { status: 400 },
          );
        }
        const site = provisionSite(slot, siteUrl, label, provisionedBy);
        if (!site) {
          return NextResponse.json(
            { error: `Site slot ${slot} not found` },
            { status: 404 },
          );
        }
        return NextResponse.json({
          provisioned: true,
          site,
          message: `Site slot ${slot} provisioned with ${siteUrl}.`,
        });
      }

      case "heartbeat": {
        const slot = Number(body.slot || 0);
        if (slot < 1 || slot > 10) {
          return NextResponse.json(
            { error: "slot (1-10) is required" },
            { status: 400 },
          );
        }
        const site = heartbeatSite(slot);
        if (!site) {
          return NextResponse.json(
            { error: `Site slot ${slot} not provisioned` },
            { status: 404 },
          );
        }
        return NextResponse.json({
          heartbeat: true,
          site,
        });
      }

      default:
        return NextResponse.json(
          {
            error: `Unknown action "${action}". Valid: route, record_result, provision_site, heartbeat.`,
          },
          { status: 400 },
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

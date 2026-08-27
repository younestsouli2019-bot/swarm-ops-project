/**
 * Autonomous API Key Activation System
 * ---------------------------------------------------------------------------
 * Operator directive (Task 14):
 *   "autonomous agents getting api keys for models [9 models listed] ...
 *    for loadbalancing blueprint of self-setup 10 sites"
 *
 * Two deployment URLs were provided as the seed of the 10-site fleet:
 *   - https://j13v96vaawp0-d.space-z.ai        (primary, AIM: SELF-SETUP)
 *   - https://n1u4v5127m40-deploy.space-z.ai   (secondary, SELF-OPTIMIZATION)
 *
 * This module implements THREE autonomous capabilities:
 *
 * 1. API KEY ACTIVATION
 *    Detects which API keys the swarm needs (from FREE_MODELS registry),
 *    identifies which are missing, and produces an activation plan that
 *    an operator-tier agent can execute. The activation plan is itself
 *    autonomous — the agent visits each provider's developer portal,
 *    requests a key, and writes it to .env. In the sandbox, the actual
 *    key-fetch is delegated to the operator (this module writes the
 *    .env entries with placeholder values and surfaces the docs_url for
 *    each missing key).
 *
 * 2. PROVIDER HEALTH MONITORING
 *    Tracks per-provider request counts, error rates, and rate-limit
 *    headroom. Marks providers as `available`, `degraded` (approaching
 *    rate limit), or `exhausted` (rate limit hit). Feeds into the load
 *    balancer's health-weighted routing.
 *
 * 3. MODEL LOAD BALANCER (the "blueprint of self-setup 10 sites")
 *    Round-robin + health-weighted routing across all available providers.
 *    Each request gets routed to the healthiest provider that supports
 *    the required capability. Falls back to the next provider on failure.
 *    The 10-site blueprint is implemented as 10 deployment slots that
 *    share a common routing table — when one site is overloaded, traffic
 *    is redirected to the next healthy site.
 *
 * Non-throwing. All operations are safe to call from the orchestrator tick.
 */

import { FREE_MODELS, getAvailableModels, type FreeModelConfig } from "./free-models";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 10-site self-setup fleet. The first 2 are real deployments; slots 3-10
 *  are reserved for autonomous spin-up. */
export interface SiteSlot {
  slot: number;
  url: string | null;
  label: string;
  status: "active" | "standby" | "unprovisioned";
  provisioned_at: string | null;
  last_heartbeat_at: string | null;
  /** 0-100 health score (computed from recent request success rate). */
  health_score: number;
  /** Requests routed to this site in the current window. */
  requests_routed: number;
  /** Requests that succeeded. */
  requests_succeeded: number;
  /** Requests that failed (4xx/5xx/timeout). */
  requests_failed: number;
}

/** Per-provider runtime health tracking. */
export interface ProviderHealth {
  provider: string;
  api_key_env: string;
  has_key: boolean;
  status: "available" | "degraded" | "exhausted" | "no_key";
  /** Requests sent in the current window. */
  requests_sent: number;
  requests_succeeded: number;
  requests_failed: number;
  /** Free-tier limit (parsed from free_tier_limit string, approximate). */
  rate_limit_per_min: number | null;
  rate_limit_per_day: number | null;
  /** Estimated remaining requests in the current window. */
  headroom_remaining: number | null;
  /** Last time this provider was used. */
  last_used_at: string | null;
  /** Last error message (if any). */
  last_error: string | null;
}

/** Activation plan for a missing API key. */
export interface KeyActivationPlan {
  env_var: string;
  provider: string;
  docs_url: string;
  portal_url: string;
  models_unlocked: Array<{ id: string; display_name: string }>;
  estimated_setup_minutes: number;
  instructions: string[];
  /** Status: pending (operator action needed), activated (key written), failed. */
  status: "pending" | "activated" | "failed";
  activated_at: string | null;
  activated_by: string | null;
}

export interface ActivationSnapshot {
  generated_at: string;
  total_models: number;
  available_models: number;
  missing_keys: KeyActivationPlan[];
  activated_keys: KeyActivationPlan[];
  provider_health: ProviderHealth[];
  /** Auto-activation is enabled when at least one key is set. */
  auto_activation_enabled: boolean;
  /** The 10-site fleet state. */
  sites: SiteSlot[];
  /** Current routing table (provider → next-site). */
  routing_table: Array<{
    provider: string;
    primary_site: number;
    fallback_sites: number[];
  }>;
  /** Stats since last reset. */
  stats: {
    total_requests_routed: number;
    total_failovers: number;
    total_keys_activated: number;
    total_keys_pending: number;
  };
}

// ---------------------------------------------------------------------------
// Provider portal URL lookup
// ---------------------------------------------------------------------------

const PROVIDER_PORTALS: Record<string, { portal: string; docs: string; est_minutes: number; instructions: string[] }> = {
  deepseek: {
    portal: "https://platform.deepseek.com/api_keys",
    docs: "https://api-docs.deepseek.com/",
    est_minutes: 3,
    instructions: [
      "Sign in at platform.deepseek.com (Google/GitHub OAuth supported)",
      "Navigate to API Keys → Create New Key",
      "Copy the sk-... key immediately (shown only once)",
      "Add to .env: DEEPSEEK_API_KEY=sk-...",
      "Restart the dev server to pick up the new env var",
    ],
  },
  openrouter: {
    portal: "https://openrouter.ai/keys",
    docs: "https://openrouter.ai/docs",
    est_minutes: 2,
    instructions: [
      "Sign in at openrouter.ai (Google/GitHub OAuth supported)",
      "Navigate to Keys → Create Key",
      "Copy the sk-or-v1-... key",
      "Add to .env: OPENROUTER_API_KEY=sk-or-v1-...",
      "Free tier: 20 req/min, 50 req/day on :free models — no credit card required",
    ],
  },
  mistral: {
    portal: "https://console.mistral.ai/api-keys",
    docs: "https://docs.mistral.ai/",
    est_minutes: 4,
    instructions: [
      "Sign up at console.mistral.ai",
      "Verify email + phone number",
      "Navigate to API Keys → Create new key",
      "Copy the key",
      "Add to .env: MISTRAL_API_KEY=...",
      "Free tier: 1 req/sec, 500k req/month",
    ],
  },
  qwen: {
    portal: "https://dashscope.console.aliyun.com/apiKey",
    docs: "https://help.aliyun.com/zh/dashscope/",
    est_minutes: 5,
    instructions: [
      "Sign in at dashscope.aliyun.com (Alibaba Cloud account required)",
      "Navigate to API-KEY Management → Create",
      "Copy the sk-... key",
      "Add to .env: DASHSCOPE_API_KEY=sk-...",
      "Free tier: 100k tokens/min for qualified users",
    ],
  },
  ollama: {
    portal: "http://localhost:11434",
    docs: "https://ollama.com/",
    est_minutes: 1,
    instructions: [
      "Install Ollama: curl -fsSL https://ollama.com/install.sh | sh",
      "Pull a model: ollama pull llama3.2",
      "Start the server: ollama serve (or it auto-starts on demand)",
      "Set OLLAMA_HOST=http://localhost:11434 in .env",
      "No API key needed — local runtime",
    ],
  },
  zai: {
    portal: "https://z.ai/manage-apikey/apikey-list",
    docs: "https://docs.z.ai/",
    est_minutes: 3,
    instructions: [
      "Sign in at z.ai/manage-apikey/apikey-list",
      "Click Create API Key",
      "Copy the key (format: xxx.yyy)",
      "Add to .env: ZAI_API_KEY=xxx.yyy",
      "GLM-4.6 is the recommended default in this sandbox",
    ],
  },
  nvidia: {
    portal: "https://build.nvidia.com/explore/discover/keys",
    docs: "https://docs.api.nvidia.com/nim/reference/overview",
    est_minutes: 3,
    instructions: [
      "Sign up at build.nvidia.com (free NVIDIA developer account)",
      "Navigate to Explore → API Keys → Generate Key",
      "Copy the nvapi-... key",
      "Add to .env: NVIDIA_API_KEY=nvapi-...",
      "Free tier: 1000 credits, 500 req/day — 55+ models available",
    ],
  },
};

// ---------------------------------------------------------------------------
// Rate-limit parsing
// ---------------------------------------------------------------------------

/** Parse a free_tier_limit string into per-min and per-day caps. */
export function parseRateLimit(
  limitStr: string,
): { per_min: number | null; per_day: number | null } {
  let per_min: number | null = null;
  let per_day: number | null = null;

  // Match "20 req/min"
  const minMatch = limitStr.match(/(\d+)\s*req\/min/i);
  if (minMatch) per_min = parseInt(minMatch[1], 10);

  // Match "50 req/day"
  const dayMatch = limitStr.match(/(\d+)\s*req\/day/i);
  if (dayMatch) per_day = parseInt(dayMatch[1], 10);

  // Match "500k req/month" → approximate to ~16k/day
  const monthMatch = limitStr.match(/(\d+(?:\.\d+)?)k?\s*req\/month/i);
  if (monthMatch && !per_day) {
    const monthly = parseFloat(monthMatch[1]) * (limitStr.includes("k") ? 1000 : 1);
    per_day = Math.floor(monthly / 30);
  }

  // Match "1 req/sec" → 60/min
  const secMatch = limitStr.match(/(\d+)\s*req\/sec/i);
  if (secMatch && !per_min) per_min = parseInt(secMatch[1], 10) * 60;

  // Match "100k tokens/min" → assume ~10 tokens/request, so ~10k req/min
  // (rough heuristic — actual rate depends on prompt size)
  const tokMatch = limitStr.match(/(\d+(?:\.\d+)?)k?\s*tokens\/min/i);
  if (tokMatch && !per_min) {
    const tokens = parseFloat(tokMatch[1]) * (limitStr.includes("k") ? 1000 : 1);
    per_min = Math.floor(tokens / 10000); // assume 10k tokens/req average
  }

  return { per_min, per_day };
}

// ---------------------------------------------------------------------------
// In-memory store (globalThis singleton — HMR-safe)
// ---------------------------------------------------------------------------

interface ActivationStore {
  /** Per-provider health, keyed by provider name. */
  providers: Map<string, ProviderHealth>;
  /** Per-env-var activation plan. */
  plans: Map<string, KeyActivationPlan>;
  /** The 10-site fleet. */
  sites: SiteSlot[];
  /** Round-robin cursor per provider (for load balancing). */
  cursors: Map<string, number>;
  /** Stats. */
  stats: {
    total_requests_routed: number;
    total_failovers: number;
    total_keys_activated: number;
    total_keys_pending: number;
  };
}

const STORE_KEY = "__charibaas_activation_store__";

function getStore(): ActivationStore {
  if (typeof globalThis !== "undefined") {
    const existing = (globalThis as unknown as Record<string, unknown>)[STORE_KEY];
    if (existing) return existing as ActivationStore;
  }
  const fresh: ActivationStore = {
    providers: new Map(),
    plans: new Map(),
    sites: initializeSites(),
    cursors: new Map(),
    stats: {
      total_requests_routed: 0,
      total_failovers: 0,
      total_keys_activated: 0,
      total_keys_pending: 0,
    },
  };
  if (typeof globalThis !== "undefined") {
    (globalThis as unknown as Record<string, unknown>)[STORE_KEY] = fresh;
  }
  return fresh;
}

/** Initialize the 10-site fleet. First 2 are the operator-provided URLs. */
function initializeSites(): SiteSlot[] {
  const seedUrls = [
    { url: "https://j13v96vaawp0-d.space-z.ai", label: "AIM: SELF-SETUP" },
    { url: "https://n1u4v5127m40-deploy.space-z.ai", label: "SELF-OPTIMIZATION" },
  ];
  const sites: SiteSlot[] = [];
  for (let i = 0; i < 10; i++) {
    const seed = seedUrls[i];
    sites.push({
      slot: i + 1,
      url: seed ? seed.url : null,
      label: seed ? seed.label : `Self-Setup Slot ${i + 1}`,
      status: seed ? "active" : "unprovisioned",
      provisioned_at: seed ? new Date().toISOString() : null,
      last_heartbeat_at: seed ? new Date().toISOString() : null,
      health_score: seed ? 100 : 0,
      requests_routed: 0,
      requests_succeeded: 0,
      requests_failed: 0,
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Refresh: scan env, refresh provider health + activation plans
// ---------------------------------------------------------------------------

/** Scan the environment and refresh provider health + activation plans. */
export function refreshActivationState(): ActivationSnapshot {
  const store = getStore();
  const available = getAvailableModels();
  const availableIds = new Set(available.map((m) => m.id));

  // Group models by api_key_env to build activation plans.
  const modelsByEnv = new Map<string, FreeModelConfig[]>();
  for (const model of FREE_MODELS) {
    const list = modelsByEnv.get(model.api_key_env) || [];
    list.push(model);
    modelsByEnv.set(model.api_key_env, list);
  }

  // Refresh provider health.
  for (const [envVar, models] of modelsByEnv) {
    const provider = models[0].provider;
    const hasKey = !!process.env[envVar];
    const existing = store.providers.get(provider);
    const rateLimit = parseRateLimit(models[0].free_tier_limit);
    const requestsSent = existing?.requests_sent ?? 0;
    const requestsSucceeded = existing?.requests_succeeded ?? 0;
    const requestsFailed = existing?.requests_failed ?? 0;

    let status: ProviderHealth["status"] = "no_key";
    if (hasKey) {
      status = "available";
      // Mark degraded if we've used > 80% of per-minute limit.
      if (rateLimit.per_min && requestsSent > 0) {
        const remaining = Math.max(0, rateLimit.per_min - requestsSent);
        if (remaining < rateLimit.per_min * 0.2) status = "degraded";
        if (remaining === 0) status = "exhausted";
      }
    }

    const health: ProviderHealth = {
      provider,
      api_key_env: envVar,
      has_key: hasKey,
      status,
      requests_sent: requestsSent,
      requests_succeeded: requestsSucceeded,
      requests_failed: requestsFailed,
      rate_limit_per_min: rateLimit.per_min,
      rate_limit_per_day: rateLimit.per_day,
      headroom_remaining: rateLimit.per_min
        ? Math.max(0, rateLimit.per_min - requestsSent)
        : null,
      last_used_at: existing?.last_used_at ?? null,
      last_error: existing?.last_error ?? null,
    };
    store.providers.set(provider, health);
  }

  // Refresh activation plans.
  for (const [envVar, models] of modelsByEnv) {
    const provider = models[0].provider;
    const hasKey = !!process.env[envVar];
    const portal = PROVIDER_PORTALS[provider] || {
      portal: "",
      docs: models[0].docs_url,
      est_minutes: 5,
      instructions: [`Set ${envVar} in .env to activate`],
    };

    const existing = store.plans.get(envVar);
    const status: KeyActivationPlan["status"] = hasKey
      ? "activated"
      : existing?.status === "failed"
        ? "failed"
        : "pending";

    const plan: KeyActivationPlan = {
      env_var: envVar,
      provider,
      docs_url: portal.docs,
      portal_url: portal.portal,
      models_unlocked: models.map((m) => ({
        id: m.id,
        display_name: m.display_name,
      })),
      estimated_setup_minutes: portal.est_minutes,
      instructions: portal.instructions,
      status,
      activated_at: hasKey
        ? existing?.activated_at ?? new Date().toISOString()
        : null,
      activated_by: hasKey
        ? existing?.activated_by ?? "operator"
        : null,
    };
    store.plans.set(envVar, plan);
  }

  // Update stats.
  const plans = Array.from(store.plans.values());
  store.stats.total_keys_activated = plans.filter((p) => p.status === "activated").length;
  store.stats.total_keys_pending = plans.filter((p) => p.status === "pending").length;

  // Build routing table — each provider routes to its primary site, with
  // fallback to the next 2 healthy sites.
  const activeSites = store.sites.filter((s) => s.status === "active");
  const routingTable: ActivationSnapshot["routing_table"] = [];
  for (const provider of store.providers.keys()) {
    const cursor = store.cursors.get(provider) ?? 0;
    const primaryIdx = cursor % Math.max(1, activeSites.length);
    const primarySite = activeSites[primaryIdx]?.slot ?? 1;
    const fallbackSites: number[] = [];
    for (let i = 1; i <= 2; i++) {
      const idx = (primaryIdx + i) % Math.max(1, activeSites.length);
      const slot = activeSites[idx]?.slot;
      if (slot && slot !== primarySite) fallbackSites.push(slot);
    }
    routingTable.push({
      provider,
      primary_site: primarySite,
      fallback_sites: fallbackSites,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    total_models: FREE_MODELS.length,
    available_models: availableIds.size,
    missing_keys: plans.filter((p) => p.status === "pending"),
    activated_keys: plans.filter((p) => p.status === "activated"),
    provider_health: Array.from(store.providers.values()),
    auto_activation_enabled: plans.some((p) => p.status === "activated"),
    sites: store.sites,
    routing_table: routingTable,
    stats: store.stats,
  };
}

// ---------------------------------------------------------------------------
// Load balancer — pick a provider for a given capability request
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  provider: string;
  model_id: string;
  endpoint: string;
  api_key_env: string;
  site_slot: number;
  site_url: string | null;
  fallback_chain: Array<{ provider: string; site_slot: number }>;
  reason: string;
}

/**
 * Pick the healthiest available provider that supports the required capability,
 * then route to the primary site for that provider.
 *
 * Health priority:
 *   1. available (has key, has headroom) — pick the one with most headroom
 *   2. degraded (approaching limit) — last resort
 *   3. exhausted / no_key — skip
 *
 * Site routing:
 *   Round-robin across active sites per provider. Cursor advances on each
 *   request. Failover chain is the next 2 sites.
 */
export function routeRequest(
  requiredCapability: string,
): RoutingDecision | null {
  const store = getStore();
  refreshActivationState();

  // Find all models that support the capability AND whose provider has a key.
  const candidates = FREE_MODELS.filter((m) => {
    if (!m.capabilities.includes(requiredCapability)) return false;
    const health = store.providers.get(m.provider);
    return health?.has_key && health.status !== "exhausted";
  });

  if (candidates.length === 0) return null;

  // Sort by health status (available > degraded) then by headroom remaining
  // (most headroom first), then by context_window (largest first).
  candidates.sort((a, b) => {
    const ha = store.providers.get(a.provider)!;
    const hb = store.providers.get(b.provider)!;
    const statusOrder: Record<string, number> = {
      available: 0,
      degraded: 1,
      exhausted: 2,
      no_key: 3,
    };
    const so = statusOrder[ha.status] - statusOrder[hb.status];
    if (so !== 0) return so;
    const hrA = ha.headroom_remaining ?? 999999;
    const hrB = hb.headroom_remaining ?? 999999;
    if (hrB !== hrA) return hrB - hrA;
    return b.context_window - a.context_window;
  });

  const chosen = candidates[0];
  const provider = chosen.provider;

  // Round-robin site selection for this provider.
  const cursor = store.cursors.get(provider) ?? 0;
  const activeSites = store.sites.filter((s) => s.status === "active");
  if (activeSites.length === 0) return null;
  const primaryIdx = cursor % activeSites.length;
  const primarySite = activeSites[primaryIdx];
  store.cursors.set(provider, cursor + 1);

  // Build fallback chain — next 2 active sites + next 2 candidate providers.
  const fallbackChain: RoutingDecision["fallback_chain"] = [];
  for (let i = 1; i <= 2; i++) {
    const idx = (primaryIdx + i) % activeSites.length;
    const site = activeSites[idx];
    if (site && site.slot !== primarySite.slot) {
      fallbackChain.push({ provider, site_slot: site.slot });
    }
  }
  for (let i = 1; i < Math.min(3, candidates.length); i++) {
    const c = candidates[i];
    fallbackChain.push({
      provider: c.provider,
      site_slot: activeSites[(primaryIdx + 1) % activeSites.length]?.slot ?? 1,
    });
  }

  // Update counters.
  primarySite.requests_routed++;
  store.stats.total_requests_routed++;
  const health = store.providers.get(provider)!;
  health.requests_sent++;
  health.last_used_at = new Date().toISOString();

  return {
    provider,
    model_id: chosen.model_id,
    endpoint: chosen.endpoint,
    api_key_env: chosen.api_key_env,
    site_slot: primarySite.slot,
    site_url: primarySite.url,
    fallback_chain: fallbackChain.slice(0, 4),
    reason: `Routed to ${provider} (${health.status}, headroom ${health.headroom_remaining ?? "∞"}) on site ${primarySite.slot} (${primarySite.label})`,
  };
}

/**
 * Record a request result (success or failure) for a previously-routed
 * request. Updates the provider + site health counters.
 */
export function recordRequestResult(
  decision: RoutingDecision,
  success: boolean,
  errorMessage?: string,
): void {
  const store = getStore();
  const site = store.sites.find((s) => s.slot === decision.site_slot);
  if (site) {
    if (success) site.requests_succeeded++;
    else site.requests_failed++;
    // Recompute site health: success_rate × 100, scaled by total requests.
    const total = site.requests_succeeded + site.requests_failed;
    if (total > 0) {
      site.health_score = Math.round((site.requests_succeeded / total) * 100);
      // If health drops below 50, mark as standby (will be re-activated by
      // the autonomous site monitor when health recovers).
      if (site.health_score < 50 && site.status === "active") {
        site.status = "standby";
      }
    }
  }

  const health = store.providers.get(decision.provider);
  if (health) {
    if (success) {
      health.requests_succeeded++;
      health.last_error = null;
    } else {
      health.requests_failed++;
      health.last_error = errorMessage ?? "unknown error";
      // If a request fails, bump the failover counter.
      store.stats.total_failovers++;
    }
  }
}

// ---------------------------------------------------------------------------
// Site provisioning — autonomously provision a new site slot
// ---------------------------------------------------------------------------

/**
 * Provision a new site slot with the given URL. Marks the slot as active.
 * Used by the autonomous self-setup agent to expand the fleet from 2 → 10.
 */
export function provisionSite(
  slot: number,
  url: string,
  label: string,
  provisionedBy: string,
): SiteSlot | null {
  const store = getStore();
  const site = store.sites.find((s) => s.slot === slot);
  if (!site) return null;
  site.url = url;
  site.label = label;
  site.status = "active";
  site.provisioned_at = new Date().toISOString();
  site.last_heartbeat_at = new Date().toISOString();
  site.health_score = 100;
  site.requests_routed = 0;
  site.requests_succeeded = 0;
  site.requests_failed = 0;
  return site;
}

/**
 * Heartbeat — ping a site and update its health. In the sandbox, this just
 * updates the last_heartbeat_at timestamp. In production, this would fetch
 * the site's /api/health endpoint.
 */
export function heartbeatSite(slot: number): SiteSlot | null {
  const store = getStore();
  const site = store.sites.find((s) => s.slot === slot);
  if (!site || site.status === "unprovisioned") return null;
  site.last_heartbeat_at = new Date().toISOString();
  // If site was standby and has had no recent failures, reactivate.
  if (site.status === "standby" && site.health_score >= 50) {
    site.status = "active";
  }
  return site;
}

// ---------------------------------------------------------------------------
// Activation plan execution — autonomously activate a key
// ---------------------------------------------------------------------------

export interface ActivationResult {
  env_var: string;
  provider: string;
  success: boolean;
  message: string;
  /** If success, the new env var value (masked). */
  masked_key?: string;
}

/**
 * Mark an API key as activated. In the sandbox, this just updates the
 * activation plan status to "activated" and writes a placeholder to the
 * in-memory env (process.env). The actual .env file write is the
 * operator's responsibility — this module produces the .env content
 * via `formatEnvFile()` so the operator can paste it in.
 *
 * In a fully autonomous deployment, this method would:
 *   1. Visit the provider portal (headless browser)
 *   2. Sign in with operator credentials (from a secret store)
 *   3. Click "Create API Key"
 *   4. Scrape the key from the response
 *   5. Write it to .env
 *   6. Restart the dev server
 *
 * For now, it accepts a key value from the operator and stores it.
 */
export function activateKey(
  envVar: string,
  keyValue: string,
  activatedBy: string,
): ActivationResult {
  const store = getStore();
  const plan = store.plans.get(envVar);
  if (!plan) {
    return {
      env_var: envVar,
      provider: "unknown",
      success: false,
      message: `No activation plan found for ${envVar}`,
    };
  }
  if (!keyValue || keyValue.trim().length < 8) {
    return {
      env_var: envVar,
      provider: plan.provider,
      success: false,
      message: `Key value too short (min 8 chars). Got: ${keyValue.length} chars.`,
    };
  }
  // Set in process.env for the current runtime.
  process.env[envVar] = keyValue.trim();
  // Update the plan.
  plan.status = "activated";
  plan.activated_at = new Date().toISOString();
  plan.activated_by = activatedBy;
  store.plans.set(envVar, plan);
  // Update stats.
  store.stats.total_keys_activated++;
  store.stats.total_keys_pending = Math.max(0, store.stats.total_keys_pending - 1);

  // Mask the key for display (show first 4 + last 4).
  const masked =
    keyValue.length > 12
      ? `${keyValue.slice(0, 4)}...${keyValue.slice(-4)}`
      : "***";

  return {
    env_var: envVar,
    provider: plan.provider,
    success: true,
    message: `${envVar} activated for provider ${plan.provider}. Unlocked ${plan.models_unlocked.length} model(s).`,
    masked_key: masked,
  };
}

/**
 * Format the current activation state as an .env file snippet the operator
 * can paste into their .env. Shows which keys are set (masked) and which
 * are pending (with placeholder).
 */
export function formatEnvFile(): string {
  const store = getStore();
  refreshActivationState();
  const lines: string[] = [
    "# ChariBaaS .env — Autonomous API Key Activation",
    "# Generated by the Agentic Stakeholder Registry activation system.",
    "# Replace <paste-your-key-here> placeholders with real keys from the provider portals.",
    "",
    "DATABASE_URL=file:/home/z/my-project/db/custom.db",
    "",
  ];
  for (const plan of store.plans.values()) {
    lines.push(`# ${plan.provider} — unlocks ${plan.models_unlocked.length} model(s)`);
    lines.push(`# Portal: ${plan.portal_url}`);
    lines.push(`# Docs: ${plan.docs_url}`);
    if (plan.status === "activated" && process.env[plan.env_var]) {
      lines.push(`${plan.env_var}=${process.env[plan.env_var]}`);
    } else {
      lines.push(`${plan.env_var}=<paste-your-key-here>`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level orchestrator hook
// ---------------------------------------------------------------------------

/**
 * Run a single autonomous activation cycle. Called from the orchestrator
 * tick (and from NEXUS LOADSTAR's 7s cycle).
 *
 * 1. Refreshes the activation state (env scan).
 * 2. Heartbeats all active sites.
 * 3. Auto-provisions any standby sites whose health has recovered.
 * 4. Returns a compact summary for the TickReport.
 */
export function runActivationCycle(): {
  snapshot: ActivationSnapshot;
  heartbeats: number;
  reactivations: number;
} {
  const snapshot = refreshActivationState();
  const store = getStore();
  let heartbeats = 0;
  let reactivations = 0;
  for (const site of store.sites) {
    if (site.status === "active") {
      heartbeatSite(site.slot);
      heartbeats++;
    } else if (site.status === "standby" && site.health_score >= 50) {
      site.status = "active";
      reactivations++;
    }
  }
  return { snapshot, heartbeats, reactivations };
}

/**
 * Autopilot Toggle & State Manager
 *
 * Allows enabling/disabling automated settlement without code changes.
 * State stored in Base44 for persistence across deployments.
 *
 * Controls:
 *   - settlement_enabled: master switch for auto-settlement
 *   - max_auto_amount: max amount per auto-settlement (safety cap)
 *   - allowed_rails: which rails are enabled
 *   - quiet_hours: pause during these hours (UTC)
 */

import { b44 } from "@/lib/base44";

// ─── Types ──────────────────────────────────────────────────────────

export interface AutopilotConfig {
  id?: string;
  settlement_enabled: boolean;
  max_auto_amount_mad: number;
  allowed_rails: string[];
  quiet_hours_start: number | null;  // UTC hour (0-23)
  quiet_hours_end: number | null;
  last_toggled_at: string | null;
  last_toggled_by: string | null;
}

const DEFAULT_CONFIG: AutopilotConfig = {
  settlement_enabled: true,
  max_auto_amount_mad: 50000,
  allowed_rails: ["wise_gbp", "wise_swift", "auto_payout"],
  quiet_hours_start: null,
  quiet_hours_end: null,
  last_toggled_at: null,
  last_toggled_by: null,
};

// ─── Config Cache ───────────────────────────────────────────────────

let cachedConfig: AutopilotConfig | null = null;
let cacheExpiresAt = 0;

// ─── Load / Save ────────────────────────────────────────────────────

export async function getAutopilotConfig(): Promise<AutopilotConfig> {
  if (cachedConfig && cacheExpiresAt > Date.now()) {
    return cachedConfig;
  }

  try {
    const configs = await b44.list("AutopilotConfig", { limit: 1 }) as AutopilotConfig[];
    if (configs.length > 0) {
      cachedConfig = configs[0];
      cacheExpiresAt = Date.now() + 30_000;
      return cachedConfig;
    }
  } catch {
    // Not found — use defaults
  }

  // Create default config
  try {
    const created = await b44.create("AutopilotConfig", DEFAULT_CONFIG) as AutopilotConfig;
    cachedConfig = created;
    cacheExpiresAt = Date.now() + 30_000;
    return cachedConfig;
  } catch {
    cachedConfig = DEFAULT_CONFIG;
    cacheExpiresAt = Date.now() + 30_000;
    return DEFAULT_CONFIG;
  }
}

export async function updateAutopilotConfig(
  updates: Partial<AutopilotConfig>,
  actor: string = "api"
): Promise<AutopilotConfig> {
  const config = await getAutopilotConfig();

  const updated = {
    ...config,
    ...updates,
    last_toggled_at: new Date().toISOString(),
    last_toggled_by: actor,
  };

  if (config.id) {
    await b44.update("AutopilotConfig", config.id, updated);
  } else {
    await b44.create("AutopilotConfig", updated);
  }

  cachedConfig = updated;
  cacheExpiresAt = Date.now() + 30_000;
  return updated;
}

// ─── Pre-checks ─────────────────────────────────────────────────────

export async function canSettleNow(amountMAD: number, rail: string): Promise<{
  allowed: boolean;
  reason: string;
}> {
  const config = await getAutopilotConfig();

  if (!config.settlement_enabled) {
    return { allowed: false, reason: "Settlement is disabled" };
  }

  if (amountMAD > config.max_auto_amount_mad) {
    return {
      allowed: false,
      reason: `Amount ${amountMAD} MAD exceeds max ${config.max_auto_amount_mad} MAD`,
    };
  }

  if (!config.allowed_rails.includes(rail)) {
    return {
      allowed: false,
      reason: `Rail "${rail}" is not in allowed rails: ${config.allowed_rails.join(", ")}`,
    };
  }

  // Quiet hours check
  if (config.quiet_hours_start !== null && config.quiet_hours_end !== null) {
    const nowUtc = new Date().getUTCHours();
    const start = config.quiet_hours_start;
    const end = config.quiet_hours_end;

    if (start <= end) {
      if (nowUtc >= start && nowUtc < end) {
        return {
          allowed: false,
          reason: `Quiet hours active (${start}:00-${end}:00 UTC)`,
        };
      }
    } else {
      if (nowUtc >= start || nowUtc < end) {
        return {
          allowed: false,
          reason: `Quiet hours active (${start}:00-${end}:00 UTC)`,
        };
      }
    }
  }

  return { allowed: true, reason: "All checks passed" };
}

export async function toggleSettlement(
  enabled: boolean,
  actor: string
): Promise<AutopilotConfig> {
  return updateAutopilotConfig({ settlement_enabled: enabled }, actor);
}

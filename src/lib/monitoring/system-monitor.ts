/**
 * Monitoring & Alerting System
 *
 * Tracks health of all components:
 *   - Revenue engine
 *   - Settlement pipeline
 *   - PSP connectivity
 *   - Bank reconciliation
 *   - Webhook delivery
 *
 * Alerts via:
 *   - Base44 Agent task
 *   - Email escalation
 *   - API response (for dashboard)
 */

import { b44 } from "@/lib/base44";

// ─── Health Check Types ─────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  last_check: string;
  last_ok?: string;
  error_count: number;
  last_error?: string;
  metrics?: Record<string, number>;
}

export interface SystemHealth {
  overall: HealthStatus;
  components: ComponentHealth[];
  alerts: Alert[];
  uptime_seconds: number;
  last_full_check: string;
}

export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  component: string;
  message: string;
  timestamp: string;
  resolved: boolean;
  resolved_at?: string;
}

// ─── Monitor ────────────────────────────────────────────────────────

export class SystemMonitor {
  private components: Map<string, ComponentHealth> = new Map();
  private alerts: Alert[] = [];
  private startTime: Date;

  constructor() {
    this.startTime = new Date();
  }

  /**
   * Run full system health check.
   */
  async checkAll(): Promise<SystemHealth> {
    const components: ComponentHealth[] = [];

    // Check each component
    components.push(await this.checkRevenueEngine());
    components.push(await this.checkSettlementPipeline());
    components.push(await this.checkPSPConnectivity());
    components.push(await this.checkBankReconciliation());
    components.push(await this.checkWebhookDelivery());
    components.push(await this.checkBase44Connectivity());

    // Update component map
    for (const c of components) {
      this.components.set(c.name, c);
    }

    // Determine overall status
    const statuses = components.map((c) => c.status);
    let overall: HealthStatus;
    if (statuses.includes("critical")) {
      overall = "critical";
    } else if (statuses.includes("degraded")) {
      overall = "degraded";
    } else if (statuses.every((s) => s === "healthy")) {
      overall = "healthy";
    } else {
      overall = "unknown";
    }

    // Generate alerts for unhealthy components
    for (const c of components) {
      if (c.status === "critical" || c.status === "degraded") {
        this.generateAlert(c);
      }
    }

    const health: SystemHealth = {
      overall,
      components,
      alerts: this.alerts.filter((a) => !a.resolved).slice(0, 20),
      uptime_seconds: Math.floor(
        (Date.now() - this.startTime.getTime()) / 1000
      ),
      last_full_check: new Date().toISOString(),
    };

    // Persist health check
    await this.persist(health);

    return health;
  }

  // ─── Component Checks ─────────────────────────────────────────

  private async checkRevenueEngine(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "revenue_engine",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    try {
      const events = await b44.list("RevenueEvent", { limit: 10 });
      const prodEvents = (events || []).filter(
        (e: Record<string, unknown>) =>
          e.environment === "production" || !e.environment
      );

      health.metrics = {
        total_events: prodEvents.length,
        recent_24h: prodEvents.filter((e: Record<string, unknown>) => {
          const date = e.confirmation_date || e.createdAt;
          if (!date) return false;
          return (
            new Date(date as string).getTime() >
            Date.now() - 24 * 60 * 60 * 1000
          );
        }).length,
      };

      if (prodEvents.length === 0) {
        health.status = "degraded";
        health.last_error = "No revenue events found";
      } else {
        health.last_ok = new Date().toISOString();
      }
    } catch (err) {
      health.status = "critical";
      health.error_count++;
      health.last_error =
        err instanceof Error ? err.message : "Unknown error";
    }

    return health;
  }

  private async checkSettlementPipeline(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "settlement_pipeline",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    try {
      const queue = await b44.list("SettlementQueue", { limit: 100 });
      const items = (queue || []) as Array<Record<string, unknown>>;
      const prodItems = items.filter(
        (i) => i.environment === "production" || !i.environment
      );

      const failed = prodItems.filter((i) => i.status === "failed").length;
      const ownerAction = prodItems.filter(
        (i) => i.status === "owner_action_required"
      ).length;

      health.metrics = {
        total: prodItems.length,
        pending: prodItems.filter((i) => i.status === "pending").length,
        submitted: prodItems.filter((i) => i.status === "submitted").length,
        completed: prodItems.filter((i) => i.status === "completed").length,
        failed,
        owner_action_required: ownerAction,
      };

      if (failed > 5) {
        health.status = "critical";
        health.last_error = `${failed} settlements failed`;
      } else if (failed > 0 || ownerAction > 0) {
        health.status = "degraded";
        health.last_error =
          ownerAction > 0
            ? `${ownerAction} require owner action`
            : `${failed} settlements failed`;
      } else {
        health.last_ok = new Date().toISOString();
      }
    } catch (err) {
      health.status = "critical";
      health.error_count++;
      health.last_error =
        err instanceof Error ? err.message : "Unknown error";
    }

    return health;
  }

  private async checkPSPConnectivity(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "psp_connectivity",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    const hasChariKey = !!process.env.CHARIPAY_API_KEY;
    const hasCMIKey = !!process.env.CMI_MERCHANT_ID;
    const hasPayoneerKey = !!process.env.PAYONEER_API_SECRET;

    health.metrics = {
      charipay_configured: hasChariKey ? 1 : 0,
      cmi_configured: hasCMIKey ? 1 : 0,
      payoneer_configured: hasPayoneerKey ? 1 : 0,
    };

    if (!hasChariKey && !hasCMIKey && !hasPayoneerKey) {
      health.status = "degraded";
      health.last_error = "No PSP configured";
    } else {
      health.last_ok = new Date().toISOString();
    }

    // Test ChariBaaS connectivity if configured
    if (hasChariKey) {
      try {
        const res = await fetch(
          "https://sandbox.charimoney.com/api/customers/status?phoneNumber=+212600000000",
          {
            headers: {
              "Chari-Api-Key": process.env.CHARIPAY_API_KEY!,
              "C-Request-Id": crypto.randomUUID(),
            },
          }
        );
        if (res.ok) {
          health.last_ok = new Date().toISOString();
        } else {
          health.status = "degraded";
          health.last_error = `ChariBaaS returned ${res.status}`;
        }
      } catch {
        health.status = "degraded";
        health.last_error = "ChariBaaS unreachable";
      }
    }

    return health;
  }

  private async checkBankReconciliation(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "bank_reconciliation",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    try {
      const ledger = await b44.list("LedgerEntry", { limit: 1000 });
      const entries = (ledger || []) as Array<Record<string, unknown>>;
      const prodEntries = entries.filter(
        (e) => e.environment === "production"
      );

      const bankCredits = prodEntries.filter(
        (e) => e.type === "bank_credit"
      ).length;
      const settlements = prodEntries.filter(
        (e) => e.type === "settlement"
      ).length;

      health.metrics = {
        total_entries: prodEntries.length,
        bank_credits: bankCredits,
        pending_settlements: settlements - bankCredits,
      };

      if (settlements > 0 && bankCredits === 0) {
        health.status = "degraded";
        health.last_error = "Settlements submitted but no bank credits received";
      } else {
        health.last_ok = new Date().toISOString();
      }
    } catch (err) {
      health.status = "unknown";
      health.last_error =
        err instanceof Error ? err.message : "Unknown error";
    }

    return health;
  }

  private async checkWebhookDelivery(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "webhook_delivery",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    try {
      const webhooks = await b44.list("WebhookEvent", { limit: 50 });
      const recent = (webhooks || []).filter(
        (w: Record<string, unknown>) => {
          const received = w.received_at || w.createdAt;
          if (!received) return false;
          return (
            new Date(received as string).getTime() >
            Date.now() - 24 * 60 * 60 * 1000
          );
        }
      );

      health.metrics = {
        total_24h: recent.length,
        charipay: recent.filter(
          (w: Record<string, unknown>) => w.source === "charipay"
        ).length,
      };

      health.last_ok = new Date().toISOString();
    } catch {
      health.status = "unknown";
    }

    return health;
  }

  private async checkBase44Connectivity(): Promise<ComponentHealth> {
    const health: ComponentHealth = {
      name: "base44_connectivity",
      status: "healthy",
      last_check: new Date().toISOString(),
      error_count: 0,
    };

    try {
      const events = await b44.list("RevenueEvent", { limit: 1 });
      if (events) {
        health.last_ok = new Date().toISOString();
      }
    } catch (err) {
      health.status = "critical";
      health.error_count++;
      health.last_error =
        err instanceof Error ? err.message : "Base44 unreachable";
    }

    return health;
  }

  // ─── Alerts ───────────────────────────────────────────────────

  private generateAlert(component: ComponentHealth): void {
    const existing = this.alerts.find(
      (a) =>
        a.component === component.name &&
        !a.resolved &&
        a.message === component.last_error
    );

    if (existing) return;

    this.alerts.push({
      id: `ALERT-${Date.now().toString(36).toUpperCase()}`,
      severity: component.status === "critical" ? "critical" : "warning",
      component: component.name,
      message: component.last_error || "Unknown issue",
      timestamp: new Date().toISOString(),
      resolved: false,
    });
  }

  resolveAlert(alertId: string): void {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolved_at = new Date().toISOString();
    }
  }

  // ─── Persistence ──────────────────────────────────────────────

  private async persist(health: SystemHealth): Promise<void> {
    try {
      await b44.create("SystemHealth", {
        overall: health.overline || health.overall,
        components_json: JSON.stringify(health.components),
        alerts_json: JSON.stringify(health.alerts),
        uptime_seconds: health.uptime_seconds,
        checked_at: health.last_full_check,
      } as never);
    } catch {
      // Non-fatal
    }
  }
}

"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  AlertOctagon,
  Info,
  Lock,
  Banknote,
  Scale,
  Server,
  Zap,
  Activity,
  Brain,
  Layers,
  ScrollText as ScrollTextIcon,
} from "./icons";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  timeAgo,
} from "./primitives";
import type {
  GuardrailState,
  GuardrailId,
  GuardrailCategory,
  GuardrailEvent,
} from "@/lib/swarm-guardrails";
import type { RedressState, RedressActionId } from "@/lib/swarm-redress";

const CATEGORY_LABEL: Record<GuardrailCategory, string> = {
  security: "Security",
  legal: "Legal & Compliance",
  infrastructure: "Infrastructure",
  economic: "Economic",
};

const CATEGORY_TONE: Record<GuardrailCategory, string> = {
  security: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  legal: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  infrastructure: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  economic: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const CATEGORY_ICON: Record<GuardrailCategory, typeof Shield> = {
  security: Lock,
  legal: Scale,
  infrastructure: Server,
  economic: Banknote,
};

const SEVERITY_TONE: Record<string, string> = {
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warning: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  critical: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const SEVERITY_ICON: Record<string, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertOctagon,
};

const REDRESS_LABEL: Record<RedressActionId, string> = {
  velocity_breaker: "Velocity Breaker",
  log_monotony_entropy: "Log Monotony Entropy",
  cannibalistic_global_lock: "Cannibalistic Lock",
  context_hydration: "Context Hydration",
};

const REDRESS_ICON: Record<RedressActionId, typeof Shield> = {
  velocity_breaker: Zap,
  log_monotony_entropy: Activity,
  cannibalistic_global_lock: Lock,
  context_hydration: Brain,
};

function useGuardrailState() {
  return useQuery<GuardrailState>({
    queryKey: ["guardrail-state"],
    queryFn: async () => {
      const r = await fetch("/api/guardrails", { cache: "no-store" });
      if (!r.ok) throw new Error(`SGR fetch failed: ${r.status}`);
      return (await r.json()) as GuardrailState;
    },
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

function useRedressState() {
  return useQuery<RedressState>({
    queryKey: ["redress-state"],
    queryFn: async () => {
      const r = await fetch("/api/redress", { cache: "no-store" });
      if (!r.ok) throw new Error(`SRE fetch failed: ${r.status}`);
      return (await r.json()) as RedressState;
    },
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

function useGuardrailAction() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { action: string; id?: string; enabled?: boolean; mode?: string }
  >({
    mutationFn: async (body) => {
      const r = await fetch("/api/guardrails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`SGR action failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["guardrail-state"] });
    },
  });
}

function useRedressAction() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { action: string; id?: string; cycle_id?: string; reason?: string }
  >({
    mutationFn: async (body) => {
      const r = await fetch("/api/redress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`SRE action failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["redress-state"] });
    },
  });
}

function GuardrailCard({
  id,
  config,
  onToggle,
  onModeChange,
}: {
  id: GuardrailId;
  config: GuardrailState["guardrails"][GuardrailId];
  onToggle: (enabled: boolean) => void;
  onModeChange: (mode: "observe" | "enforce") => void;
}) {
  const Icon = CATEGORY_ICON[config.category];
  return (
    <Card className="bg-card/60 border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="text-[13px] truncate">{config.label}</CardTitle>
          </div>
          <Switch checked={config.enabled} onCheckedChange={onToggle} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {config.description}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={`text-[9px] font-mono ${CATEGORY_TONE[config.category]}`}>
            {CATEGORY_LABEL[config.category]}
          </Badge>
          <Badge
            variant="outline"
            className={`text-[9px] font-mono ${
              config.mode === "enforce"
                ? "bg-rose-500/10 text-rose-300 border-rose-500/30"
                : "bg-sky-500/10 text-sky-300 border-sky-500/30"
            }`}
          >
            {config.mode}
          </Badge>
          <Badge variant="outline" className="text-[9px] font-mono">
            {config.triggered_count} fired
          </Badge>
          {config.blocked_count > 0 && (
            <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
              {config.blocked_count} blocked
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 pt-1">
          <Button
            size="sm"
            variant={config.mode === "observe" ? "default" : "outline"}
            className="h-6 px-2 text-[10px]"
            onClick={() => onModeChange("observe")}
          >
            Observe
          </Button>
          <Button
            size="sm"
            variant={config.mode === "enforce" ? "default" : "outline"}
            className="h-6 px-2 text-[10px]"
            onClick={() => onModeChange("enforce")}
          >
            Enforce
          </Button>
          {config.last_fired_at && (
            <span className="ml-auto text-[9px] font-mono text-muted-foreground">
              last: {timeAgo(config.last_fired_at)}
            </span>
          )}
        </div>
        {/* Stats summary */}
        {Object.keys(config.stats).length > 0 && (
          <div className="pt-1 border-t border-border/40 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
            {Object.entries(config.stats).slice(0, 6).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-1">
                <span className="text-muted-foreground truncate">{k}</span>
                <span className="text-foreground tabular-nums">
                  {typeof v === "number" ? v.toLocaleString() : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RedressActionCard({
  id,
  action,
  onClear,
  onTrigger,
}: {
  id: RedressActionId;
  action: RedressState["actions"][RedressActionId];
  onClear: () => void;
  onTrigger: () => void;
}) {
  const Icon = REDRESS_ICON[id];
  return (
    <Card
      className={`bg-card/60 border-border/60 ${
        action.active ? "ring-1 ring-amber-500/40 border-amber-500/30" : ""
      }`}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              className={`h-4 w-4 shrink-0 ${
                action.active ? "text-amber-300" : "text-muted-foreground"
              }`}
            />
            <CardTitle className="text-[13px] truncate">{REDRESS_LABEL[id]}</CardTitle>
          </div>
          {action.active ? (
            <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse">
              ACTIVE
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
              idle
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {action.description}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[9px] font-mono">
            {action.triggered_count} triggered
          </Badge>
          {action.last_triggered_at && (
            <span className="text-[9px] font-mono text-muted-foreground">
              last: {timeAgo(action.last_triggered_at)}
            </span>
          )}
        </div>
        {action.last_trigger_reason && (
          <div className="text-[10px] font-mono bg-muted/40 border border-border/40 rounded p-1.5 leading-snug">
            <span className="text-muted-foreground">reason: </span>
            <span className="text-foreground">{action.last_trigger_reason}</span>
          </div>
        )}
        {Object.keys(action.runtime).length > 0 && (
          <div className="pt-1 border-t border-border/40 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
            {Object.entries(action.runtime).slice(0, 4).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-1">
                <span className="text-muted-foreground truncate">{k}</span>
                <span className="text-foreground tabular-nums">
                  {typeof v === "number" ? v.toLocaleString() : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={onTrigger}
          >
            Trigger
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={onClear}
            disabled={!action.active}
          >
            Clear
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EventRow({ event }: { event: GuardrailEvent }) {
  const Icon = SEVERITY_ICON[event.severity] || Info;
  return (
    <div className="border-b border-border/40 py-1.5 px-1 hover:bg-muted/20">
      <div className="flex items-center gap-2 text-[10px]">
        <Icon
          className={`h-3 w-3 shrink-0 ${
            event.severity === "critical"
              ? "text-rose-300"
              : event.severity === "warning"
                ? "text-amber-300"
                : "text-sky-300"
          }`}
        />
        <span className="font-mono text-muted-foreground">{timeAgo(event.detected_at)}</span>
        <Badge variant="outline" className={`text-[9px] font-mono ${CATEGORY_TONE[event.category]}`}>
          {CATEGORY_LABEL[event.category]}
        </Badge>
        {event.blocked && (
          <Badge variant="outline" className="text-[9px] font-mono bg-rose-500/15 text-rose-300 border-rose-500/30">
            BLOCKED
          </Badge>
        )}
      </div>
      <div className="text-[11px] mt-0.5 text-foreground leading-snug">
        {event.description}
      </div>
      {event.recommendation && (
        <div className="text-[10px] mt-0.5 text-muted-foreground leading-snug">
          <span className="text-emerald-300/70">→ </span>
          {event.recommendation}
        </div>
      )}
    </div>
  );
}

export function GuardrailsView() {
  const q = useGuardrailState();
  const qr = useRedressState();
  const action = useGuardrailAction();
  const redressAction = useRedressAction();
  const sgr = q.data;
  const sre = qr.data;

  if (q.isLoading && !sgr) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <div className="text-sm text-muted-foreground">Loading guardrails state…</div>
      </div>
    );
  }

  if (!sgr) {
    return (
      <EmptyState
        title="Guardrails state unavailable"
        hint={q.error?.message || "Unknown error"}
      />
    );
  }

  const guardrailList = Object.values(sgr.guardrails);
  const byCategory: Record<GuardrailCategory, typeof guardrailList> = {
    security: [],
    legal: [],
    infrastructure: [],
    economic: [],
  };
  for (const g of guardrailList) {
    byCategory[g.category].push(g);
  }

  const criticalCount = sgr.events.filter((e) => e.severity === "critical").length;
  const warningCount = sgr.events.filter((e) => e.severity === "warning").length;
  const blockedCount = sgr.events.filter((e) => e.blocked).length;
  const activeRedress = sre ? Object.values(sre.actions).filter((a) => a.active).length : 0;

  return (
    <div className="space-y-4">
      {/* Top KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <KpiCard
          icon={Shield}
          label="Guardrails"
          value={String(guardrailList.filter((g) => g.enabled).length)}
          delta={`of ${guardrailList.length} enabled`}
          accent="emerald"
        />
        <KpiCard
          icon={ShieldAlert}
          label="Critical Events"
          value={String(criticalCount)}
          delta="in current log"
          accent={criticalCount > 0 ? "rose" : "emerald"}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Warnings"
          value={String(warningCount)}
          delta="in current log"
          accent={warningCount > 0 ? "amber" : "emerald"}
        />
        <KpiCard
          icon={AlertOctagon}
          label="Blocked Actions"
          value={String(blockedCount)}
          delta="enforce-mode hits"
          accent={blockedCount > 0 ? "amber" : "emerald"}
        />
        <KpiCard
          icon={Zap}
          label="Active Redress"
          value={String(activeRedress)}
          delta={activeRedress > 0 ? "HOLDING" : "idle"}
          accent={activeRedress > 0 ? "amber" : "emerald"}
        />
        <KpiCard
          icon={Layers}
          label="Global Mode"
          value={sgr.mode}
          delta={sgr.mode === "enforce" ? "blocking on" : "log only"}
          accent={sgr.mode === "enforce" ? "rose" : "violet"}
        />
      </div>

      {/* Active redress banner */}
      {sre && activeRedress > 0 && (
        <Card className="bg-amber-500/10 border-amber-500/40">
          <CardContent className="py-3 flex items-center gap-3 flex-wrap">
            <ShieldAlert className="h-5 w-5 text-amber-300" />
            <div className="flex-1 min-w-[200px]">
              <div className="text-sm font-semibold text-amber-100">
                Self-Redress Active — {activeRedress} action(s) holding
              </div>
              <div className="text-[11px] text-amber-200/70">
                The swarm has detected manifestation signals and is automatically
                executing remediation. Payout creation may be halted; route
                shifting may be in effect.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 bg-amber-500/15 border-amber-500/40 text-amber-200 hover:bg-amber-500/25"
              onClick={() => redressAction.mutate({ action: "clear_all" })}
            >
              Clear All Redress
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Redress actions */}
      {sre && (
        <>
          <SectionHeader
            title="Self-Redress Engine"
            subtitle="Automated remediation triggered by active manifestation signals"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {(Object.keys(sre.actions) as RedressActionId[]).map((id) => (
              <RedressActionCard
                key={id}
                id={id}
                action={sre.actions[id]}
                onClear={() => redressAction.mutate({ action: "clear", id })}
                onTrigger={() =>
                  redressAction.mutate({
                    action: "trigger",
                    id,
                    cycle_id: id === "cannibalistic_global_lock" ? `cycle-${Date.now()}` : undefined,
                    reason: "manual trigger from UI",
                  })
                }
              />
            ))}
          </div>
        </>
      )}

      {/* Guardrails by category */}
      {(Object.keys(byCategory) as GuardrailCategory[]).map((cat) => (
        <div key={cat}>
          <SectionHeader
            title={`${CATEGORY_LABEL[cat]} Guardrails`}
            subtitle={`${byCategory[cat].filter((g) => g.enabled).length} of ${byCategory[cat].length} active`}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {byCategory[cat].map((g) => (
              <GuardrailCard
                key={g.id}
                id={g.id}
                config={g}
                onToggle={(enabled) => action.mutate({ action: "set_enabled", id: g.id, enabled })}
                onModeChange={(mode) => action.mutate({ action: "set_mode", id: g.id, mode })}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Event log */}
      <SectionHeader
        title="Guardrail Event Log"
        subtitle={`${sgr.events.length} event(s) — most recent first`}
        right={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            onClick={() => action.mutate({ action: "clear_events" })}
          >
            Clear Log
          </Button>
        }
      />
      <Card className="bg-card/40 border-border/60">
        <CardContent className="p-0">
          <ScrollArea className="h-[400px] px-2">
            {sgr.events.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                No guardrail events. The swarm is operating within policy.
              </div>
            ) : (
              sgr.events.slice(0, 100).map((e) => <EventRow key={e.id} event={e} />)
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Redress log */}
      {sre && sre.log.length > 0 && (
        <>
          <SectionHeader
            title="Self-Redress Action Log"
            subtitle={`${sre.log.length} trigger/clear events`}
            right={
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px]"
                onClick={() => redressAction.mutate({ action: "clear_log" })}
              >
                Clear Log
              </Button>
            }
          />
          <Card className="bg-card/40 border-border/60">
            <CardContent className="p-0">
              <ScrollArea className="h-[200px] px-2">
                {sre.log.slice(0, 50).map((e) => (
                  <div key={e.id} className="border-b border-border/40 py-1.5 px-1">
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="font-mono text-muted-foreground">{timeAgo(e.at)}</span>
                      <Badge
                        variant="outline"
                        className={`text-[9px] font-mono ${
                          e.event === "triggered"
                            ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                            : e.event === "cleared"
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                              : "bg-sky-500/15 text-sky-300 border-sky-500/30"
                        }`}
                      >
                        {e.event}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] font-mono">
                        {REDRESS_LABEL[e.action]}
                      </Badge>
                    </div>
                    <div className="text-[11px] mt-0.5 text-foreground leading-snug">
                      {e.reason}
                    </div>
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>
        </>
      )}

      <Separator />
      <div className="text-[10px] text-muted-foreground font-mono">
        SIG (Swarm Integrity Guard) → 13 anti-pattern loops &nbsp;·&nbsp;
        SGR (Swarm Guardrails) → 12 risk-category safeguards &nbsp;·&nbsp;
        SRE (Self-Redress Engine) → 4 automated remediation actions
      </div>
    </div>
  );
}

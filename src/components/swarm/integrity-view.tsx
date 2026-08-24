"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  AlertOctagon,
  Info,
  Clock,
  TrendingUp,
  Layers,
  Ban,
} from "./icons";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  fmtUsd,
  timeAgo,
} from "./primitives";
import type { SigState, BreachSeverity, BreachPattern } from "@/lib/swarm-integrity";

const PATTERN_LABEL: Record<BreachPattern, string> = {
  hallucinated_arbitrage: "Hallucinated Arbitrage Loop",
  hyper_optimization_spiral: "Hyper-Optimization Death Spiral",
  echo_chamber_consensus: "Echo-Chamber Consensus",
  risk_aversion_paralysis: "Risk-Aversion Paralysis",
  cannibalistic_competition: "Cannibalistic Competition",
  sub_agent_proliferation: "Sub-Agent Proliferation",
  sunk_cost_resource_sink: "Sunk-Cost Resource Sink",
  context_window_drift: "Context-Window Amnesia Drift",
  penny_wise_compute: "Penny-Wise Compute Drain",
  fragile_monopoly: "Fragile Exploitation Monopoly",
  velocity_without_velocity: "Velocity without Velocity",
  token_to_revenue_decoupling: "Token-to-Revenue Decoupling",
  log_monotony: "Log Monotony",
};

const SEVERITY_TONE: Record<BreachSeverity, string> = {
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warning: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  critical: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const SEVERITY_ICON: Record<BreachSeverity, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertOctagon,
};

/** Poll /api/sig every 5s. */
function useSigState() {
  return useQuery<SigState>({
    queryKey: ["sig-state"],
    queryFn: async () => {
      const r = await fetch("/api/sig", { cache: "no-store" });
      if (!r.ok) throw new Error(`SIG fetch failed: ${r.status}`);
      return (await r.json()) as SigState;
    },
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

function useSigAction() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { action: string; mode?: string }>({
    mutationFn: async (body) => {
      const r = await fetch("/api/sig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`SIG action failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sig-state"] });
    },
  });
}

export function IntegrityView() {
  const q = useSigState();
  const action = useSigAction();
  const sig = q.data;

  if (q.isLoading && !sig) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <div className="text-sm text-muted-foreground">Loading SIG state…</div>
      </div>
    );
  }
  if (q.isError && !sig) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <div className="h-10 w-10 rounded-full bg-rose-500/15 text-rose-300 flex items-center justify-center">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <div className="text-sm font-medium">Couldn't reach the SIG endpoint</div>
        <div className="text-xs text-muted-foreground max-w-md">
          {(q.error as Error)?.message || "Check /api/sig and the dev server."}
        </div>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!sig) return null;

  const criticalCount = sig.breaches.filter((b) => b.severity === "critical").length;
  const warningCount = sig.breaches.filter((b) => b.severity === "warning").length;
  const infoCount = sig.breaches.filter((b) => b.severity === "info").length;

  const realVsPhantomRatio =
    sig.signals.phantom_revenue_cents > 0
      ? sig.signals.real_revenue_cents /
        (sig.signals.real_revenue_cents + sig.signals.phantom_revenue_cents)
      : sig.signals.real_revenue_cents > 0
        ? 1
        : 0;

  const totalHashes =
    sig.signals.unique_result_hashes + sig.signals.duplicate_result_hashes;
  const dupeRate =
    totalHashes > 0 ? sig.signals.duplicate_result_hashes / totalHashes : 0;

  return (
    <div className="space-y-6">
      {/* Mode + halt banner */}
      <Card
        className={
          sig.halt_active
            ? "bg-rose-500/10 border-rose-500/40"
            : sig.mode === "halt"
              ? "bg-amber-500/10 border-amber-500/40"
              : "bg-emerald-500/10 border-emerald-500/40"
        }
      >
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {sig.halt_active ? (
                <ShieldAlert className="h-8 w-8 text-rose-300 shrink-0" />
              ) : sig.mode === "halt" ? (
                <Shield className="h-8 w-8 text-amber-300 shrink-0" />
              ) : (
                <ShieldCheck className="h-8 w-8 text-emerald-300 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-semibold tracking-tight">
                  {sig.halt_active
                    ? "Swarm HALTED by SIG"
                    : sig.mode === "halt"
                      ? "SIG in HALT mode — no critical breach active"
                      : "SIG in OBSERVE mode — logging breaches, not halting"}
                </div>
                {sig.halt_reason && (
                  <div className="text-xs text-rose-200/80 font-mono mt-0.5 break-all">
                    {sig.halt_reason}
                  </div>
                )}
                {!sig.halt_reason && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    13 anti-pattern safeguards active · {sig.breaches.length} breach
                    {sig.breaches.length === 1 ? "" : "es"} logged · last evaluated{" "}
                    {timeAgo(sig.last_evaluated_at)}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {sig.halt_active && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => action.mutate({ action: "clear_halt" })}
                  disabled={action.isPending}
                >
                  Clear halt
                </Button>
              )}
              <Button
                size="sm"
                variant={sig.mode === "halt" ? "default" : "outline"}
                onClick={() =>
                  action.mutate({
                    action: "set_mode",
                    mode: sig.mode === "halt" ? "observe" : "halt",
                  })
                }
                disabled={action.isPending}
              >
                {sig.mode === "halt" ? "Switch to OBSERVE" : "Switch to HALT"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => action.mutate({ action: "clear_breaches" })}
                disabled={action.isPending || sig.breaches.length === 0}
              >
                Clear breaches
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Breach KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Critical breaches"
          value={criticalCount}
          delta="would halt tick() in HALT mode"
          icon={AlertOctagon}
          accent="rose"
        />
        <KpiCard
          label="Warnings"
          value={warningCount}
          delta="anti-patterns detected, logged only"
          icon={AlertTriangle}
          accent="amber"
        />
        <KpiCard
          label="Info events"
          value={infoCount}
          delta="safeguard actions taken"
          icon={Info}
          accent="emerald"
        />
        <KpiCard
          label="Total breaches"
          value={sig.breaches.length}
          delta={`cap 200 · ${timeAgo(sig.generated_at)}`}
          icon={Shield}
          accent="violet"
        />
      </div>

      {/* Manifestation signals */}
      <SectionHeader
        title="Manifestation signals"
        subtitle="Live monitoring of the three systemic red flags that indicate a swarm has trapped itself."
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Velocity without velocity */}
        <SignalCard
          title="Velocity without Velocity"
          icon={TrendingUp}
          tone={
            sig.signals.api_actions_total >= 500 && sig.signals.real_revenue_cents === 0
              ? "danger"
              : "ok"
          }
          primary={`${sig.signals.api_actions_total.toLocaleString()} API actions`}
          secondary={
            sig.signals.real_revenue_cents > 0
              ? `${fmtUsd(sig.signals.real_revenue_cents, { fromCents: true })} real revenue`
              : "$0.00 real revenue"
          }
          hint="High API traffic + flatlined real revenue = the swarm is moving but producing nothing."
        />

        {/* Token-to-revenue decoupling */}
        <SignalCard
          title="Token-to-Revenue Decoupling"
          icon={Layers}
          tone={
            sig.signals.tokens_consumed_estimate >= 100_000 &&
            sig.signals.real_revenue_cents === 0 &&
            sig.signals.phantom_revenue_cents > 0
              ? "danger"
              : "ok"
          }
          primary={`~${sig.signals.tokens_consumed_estimate.toLocaleString()} tokens`}
          secondary={`$${(sig.signals.phantom_revenue_cents / 100).toFixed(2)} phantom · $${(sig.signals.real_revenue_cents / 100).toFixed(2)} real`}
          hint="Tokens consumed per dollar of real revenue. Spiking = the swarm is burning compute without producing value."
        />

        {/* Log monotony */}
        <SignalCard
          title="Log Monotony"
          icon={Clock}
          tone={dupeRate > 0.7 && totalHashes >= 50 ? "danger" : "ok"}
          primary={`${(dupeRate * 100).toFixed(0)}% duplicate result_data`}
          secondary={`${sig.signals.unique_result_hashes} unique / ${totalHashes} sampled`}
          hint=">70% duplicates in recent task result_data = the swarm is reframing the same action under different labels."
        />
      </div>

      {/* Real vs Phantom Revenue */}
      <SectionHeader
        title="Real vs. phantom revenue"
        subtitle="The Hyper-Optimization Death Spiral signal: phantom revenue grows while real (externally-confirmed) revenue stays flat."
      />

      <Card className="bg-card/60">
        <CardContent className="p-4 sm:p-5">
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Real revenue (externally confirmed)
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-300">
                {fmtUsd(sig.signals.real_revenue_cents, { fromCents: true })}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Bank deposit, PayPal payout id, or on-chain tx hash observed.
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Phantom revenue (self-reported)
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-rose-300">
                {fmtUsd(sig.signals.phantom_revenue_cents, { fromCents: true })}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Swarm wrote the entry; no external witness.
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Real-to-total ratio
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {(realVsPhantomRatio * 100).toFixed(1)}%
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Should approach 100%. Anything below 50% with phantom &gt; $100 is a critical breach.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Safeguards */}
      <SectionHeader
        title="Safeguards"
        subtitle="One safeguard per anti-pattern. All enabled by default."
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <SafeguardCard
          name="Class A external-signal gate"
          enabled={sig.safeguards.class_a_gate.enabled}
          stat={`${sig.safeguards.class_a_gate.blocked_count} blocked`}
          description={sig.safeguards.class_a_gate.description}
        />
        <SafeguardCard
          name="Global opportunity lock"
          enabled={sig.safeguards.opportunity_lock.enabled}
          stat={`${sig.safeguards.opportunity_lock.locks_held} held this tick`}
          description={sig.safeguards.opportunity_lock.description}
        />
        <SafeguardCard
          name="Spawn budget"
          enabled={sig.safeguards.spawn_budget.enabled}
          stat={`cap ${sig.safeguards.spawn_budget.per_parent_cap}/parent · ${sig.safeguards.spawn_budget.spawns_blocked} blocked`}
          description={sig.safeguards.spawn_budget.description}
        />
        <SafeguardCard
          name="Stale-asset void"
          enabled={sig.safeguards.stale_asset_void.enabled}
          stat={`${sig.safeguards.stale_asset_void.max_age_days}d max · ${sig.safeguards.stale_asset_void.voided_count} voided`}
          description={sig.safeguards.stale_asset_void.description}
        />
        <SafeguardCard
          name="Seed-hash drift check"
          enabled={sig.safeguards.seed_hash_check.enabled}
          stat={`${sig.safeguards.seed_hash_check.drift_count} drift events`}
          description={sig.safeguards.seed_hash_check.description}
        />
        <SafeguardCard
          name="Diversification floor"
          enabled={sig.safeguards.diversification_floor.enabled}
          stat={`max ${sig.safeguards.diversification_floor.max_source_pct}%/source · ${sig.safeguards.diversification_floor.breaches} breaches`}
          description={sig.safeguards.diversification_floor.description}
        />
        <SafeguardCard
          name="Min-action floor"
          enabled={sig.safeguards.min_action_floor.enabled}
          stat={`${sig.safeguards.min_action_floor.window_hours}h window`}
          description={sig.safeguards.min_action_floor.description}
        />
      </div>

      {/* Breach log */}
      <SectionHeader
        title="Breach log"
        subtitle="Most recent first. Auto-rate-limited to 1 breach per pattern per hour."
        right={
          <Badge variant="outline" className="font-mono text-[10px]">
            {sig.breaches.length} entr{sig.breaches.length === 1 ? "y" : "ies"}
          </Badge>
        }
      />

      <Card className="bg-card/60">
        <CardContent className="p-0">
          {sig.breaches.length === 0 ? (
            <EmptyState
              title="No breaches recorded"
              hint="Run a few ticks — SIG will log any anti-pattern it detects."
            />
          ) : (
            <ScrollArea className="h-[480px]">
              <div className="divide-y divide-border/40">
                {sig.breaches.map((b) => {
                  const Icon = SEVERITY_ICON[b.severity];
                  return (
                    <div key={b.id} className="p-3.5 hover:bg-background/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <div
                          className={
                            "rounded-md p-1.5 shrink-0 border " +
                            SEVERITY_TONE[b.severity]
                          }
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <Badge
                              variant="outline"
                              className={
                                "text-[9px] font-mono uppercase " + SEVERITY_TONE[b.severity]
                              }
                            >
                              {b.severity}
                            </Badge>
                            <span className="text-[11px] font-mono text-muted-foreground">
                              {PATTERN_LABEL[b.pattern] || b.pattern}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60 ml-auto">
                              {timeAgo(b.detected_at)}
                            </span>
                          </div>
                          <div className="text-xs text-foreground/90 mb-1.5 break-words">
                            {b.description}
                          </div>
                          {b.evidence && Object.keys(b.evidence).length > 0 && (
                            <pre className="text-[10px] font-mono text-muted-foreground/80 bg-background/40 border border-border/40 rounded p-2 mb-1.5 overflow-x-auto">
                              {JSON.stringify(b.evidence, null, 2)}
                            </pre>
                          )}
                          <div className="text-[11px] text-muted-foreground">
                            <span className="text-muted-foreground/70">→ </span>
                            {b.recommendation}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="text-[10px] text-muted-foreground/70 font-mono">
        SIG state is in-memory — it resets when the dev server restarts. Authoritative swarm
        freeze (from the payout reconciler) lives in <code>.autonomous-state.json</code>.
        Last tick: {timeAgo(sig.signals.last_tick_at)} · last real action:{" "}
        {timeAgo(sig.signals.last_real_action_at)}.
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function SignalCard({
  title,
  icon: Icon,
  tone,
  primary,
  secondary,
  hint,
}: {
  title: string;
  icon: typeof Info;
  tone: "ok" | "danger";
  primary: string;
  secondary: string;
  hint: string;
}) {
  const toneClass =
    tone === "danger"
      ? "border-rose-500/40 bg-rose-500/5"
      : "border-emerald-500/30 bg-emerald-500/5";
  const iconClass =
    tone === "danger" ? "text-rose-300 bg-rose-500/15" : "text-emerald-300 bg-emerald-500/15";
  return (
    <Card className={toneClass}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground truncate">
            {title}
          </div>
          <div className={"rounded-md p-1.5 " + iconClass}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="text-lg font-semibold tabular-nums">{primary}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{secondary}</div>
        <div className="text-[10px] text-muted-foreground/70 mt-2 leading-snug">{hint}</div>
      </CardContent>
    </Card>
  );
}

function SafeguardCard({
  name,
  enabled,
  stat,
  description,
}: {
  name: string;
  enabled: boolean;
  stat: string;
  description: string;
}) {
  return (
    <Card
      className={
        enabled
          ? "bg-card/60 border-emerald-500/20"
          : "bg-card/60 border-rose-500/30 opacity-70"
      }
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="text-sm font-medium truncate">{name}</div>
          {enabled ? (
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300 shrink-0" />
          ) : (
            <Ban className="h-3.5 w-3.5 text-rose-300 shrink-0" />
          )}
        </div>
        <div className="text-[11px] font-mono text-muted-foreground mb-2">{stat}</div>
        <div className="text-[10px] text-muted-foreground/70 leading-snug">{description}</div>
      </CardContent>
    </Card>
  );
}

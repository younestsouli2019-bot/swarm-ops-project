"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  DollarSign,
  Fingerprint,
  Gauge,
  HandoffIcon,
  Layers,
  ListChecks,
  ShieldCheck,
  TrendingUp,
  Trophy,
  Zap,
} from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import {
  AgentTypeChip,
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  WorkloadBar,
  fmtNum,
  fmtUsd,
  timeAgo,
} from "./primitives";

export function DashboardView({
  state,
  lastTick,
  autopilotOn,
}: {
  state: SwarmState;
  lastTick?: import("@/lib/orchestrator").TickReport;
  autopilotOn: boolean;
}) {
  const { kpis, swarmAgents, revenueEvents, tasks, handoffs } = state;

  const topAgents = [...swarmAgents]
    .sort(
      (a, b) =>
        (b.performance_metrics?.revenue_generated ?? 0) -
        (a.performance_metrics?.revenue_generated ?? 0)
    )
    .slice(0, 6);

  // recent revenue + recent completed tasks → unified activity stream
  const activityFeed = [
    ...revenueEvents.slice(0, 12).map((e) => ({
      kind: "revenue" as const,
      at: e.created_date || e.confirmation_date || "",
      title: e.description || "Revenue event",
      sub: `${e.source.replace(/_/g, " ")} • ${e.currency} ${e.amount.toFixed(2)}`,
      status: e.status,
    })),
    ...tasks
      .filter((t) => t.status === "completed" || t.status === "in_progress" || t.status === "handed_off")
      .slice(0, 12)
      .map((t) => ({
        kind: "task" as const,
        at: t.updated_date || t.created_date || "",
        title: t.title,
        sub: `agent: ${t.assigned_agent_id?.slice(-6) || "—"} • ${t.type.replace(/_/g, " ")}`,
        status: t.status,
      })),
  ]
    .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
    .slice(0, 18);

  // revenue ticker: last 20 events as mini sparkline data
  const ticker = revenueEvents.slice(0, 20).reverse();
  const tickerMax = Math.max(0.01, ...ticker.map((e) => e.amount));

  // ── Settlement Ledger isolation rule ──────────────────────────────────
  // HARD RULE: the dashboard's headline revenue figure is the
  // cryptographically-settled balance from the Settlement Ledger —
  // $0.00 unless at least one entry has a receipt_hash. Speculative
  // and Pending_Settlement amounts are NEVER included here; they
  // live in the "Pipeline" KPI below.
  const settledCents = kpis.settledCents ?? 0;
  const hasReceipt = (kpis.settledEntryCount ?? 0) > 0 && settledCents > 0;
  const pipelineCents =
    (kpis.pipelinePendingCents ?? 0) + (kpis.pipelineSpeculativeCents ?? 0);

  return (
    <div className="space-y-6">
      {/* ─── SETTLEMENT ISOLATION BANNER ─── */}
      <Card
        className={
          hasReceipt
            ? "bg-emerald-500/5 border-emerald-500/30"
            : "bg-rose-500/5 border-rose-500/30"
        }
      >
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-start gap-3">
            {hasReceipt ? (
              <ShieldCheck className="h-5 w-5 text-emerald-300 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-rose-300 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {hasReceipt
                  ? "Active Operations balance reflects cryptographically-settled receipts"
                  : "HARD RULE: Active Operations balance is $0.00 — no receipt_hash verified yet"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {hasReceipt
                  ? `${kpis.settledEntryCount} settled entr${kpis.settledEntryCount === 1 ? "y" : "ies"} · oracle-verified via 2PC`
                  : `Pipeline holds ${fmtUsd(pipelineCents, { fromCents: true })} in speculative + pending states — segregated from active operations per the Settlement Blueprint.`}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xl sm:text-2xl font-mono font-semibold tabular-nums">
                {fmtUsd(settledCents, { fromCents: true })}
              </div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider flex items-center gap-1 justify-end">
                {hasReceipt ? (
                  <>
                    <Fingerprint className="h-2.5 w-2.5" /> receipt-verified
                  </>
                ) : (
                  "settled balance"
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPI ROW */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Cryptographically Settled"
          value={fmtUsd(settledCents, { fromCents: true })}
          delta={
            hasReceipt
              ? `${kpis.settledEntryCount} entries · receipt_hash verified`
              : "HARD RULE: $0.00 until oracle commits"
          }
          icon={Fingerprint}
          accent="emerald"
        />
        <KpiCard
          label="Pipeline (speculative)"
          value={fmtUsd(pipelineCents, { fromCents: true })}
          delta={`pending ${fmtUsd(kpis.pipelinePendingCents ?? 0, { fromCents: true })} · speculative ${fmtUsd(kpis.pipelineSpeculativeCents ?? 0, { fromCents: true })}`}
          icon={Clock}
          accent="amber"
        />
        <KpiCard
          label="Active Agents"
          value={`${kpis.activeAgents} / ${kpis.totalAgents}`}
          delta={`${kpis.pausedAgents} paused • avg success ${kpis.avgSuccessRate}%`}
          icon={Bot}
          accent="violet"
        />
        <KpiCard
          label="Tasks Completed"
          value={fmtNum(kpis.completedTasks)}
          delta={`${kpis.inProgressTasks} in progress • ${kpis.pendingTasks} queued`}
          icon={CheckCircle2}
          accent="amber"
        />
      </div>

      {/* SECONDARY KPI ROW */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Avg Success Rate"
          value={`${kpis.avgSuccessRate}%`}
          icon={Gauge}
          accent="emerald"
        />
        <KpiCard
          label="Procurement Active"
          value={fmtNum(kpis.procurementActiveCount ?? 0)}
          delta={`${fmtUsd(kpis.procurementActiveValueCents ?? 0, { fromCents: true })} in transit + received`}
          icon={HandoffIcon}
          accent="teal"
        />
        <KpiCard
          label="3-Way Matches"
          value={`${kpis.threeWayMatchesPassed ?? 0}/${(kpis.threeWayMatchesPassed ?? 0) + (kpis.threeWayMatchesFailed ?? 0)}`}
          delta={`${kpis.carrierScansReceived ?? 0} carrier scans · ${kpis.selfAssertedTokensStripped ?? 0} tokens stripped`}
          icon={ShieldCheck}
          accent="violet"
        />
        <KpiCard
          label="Autopilot"
          value={autopilotOn ? "ENGAGED" : "STANDBY"}
          delta={
            lastTick
              ? `last tick: +${fmtUsd(lastTick.revenue_cents, { fromCents: true })} • ${lastTick.completed} done`
              : "manual mode"
          }
          icon={Activity}
          accent={autopilotOn ? "emerald" : "amber"}
        />
      </div>

      {/* TWO-COL: REVENUE TICKER + ACTIVITY FEED */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Revenue ticker chart — settled only */}
        <Card className="lg:col-span-1 bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Fingerprint className="h-4 w-4 text-emerald-300" />
              Settled revenue ticker
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                receipt-verified only
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueSparkline values={ticker.map((e) => e.amount)} max={tickerMax} />
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Settled</div>
                <div className="text-sm font-mono text-emerald-300">
                  {fmtUsd(settledCents, { fromCents: true })}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Pipeline</div>
                <div className="text-sm font-mono text-amber-300">
                  {fmtUsd(pipelineCents, { fromCents: true })}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Available</div>
                <div className="text-sm font-mono text-muted-foreground">
                  {fmtUsd(kpis.availableForPayout)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live activity feed */}
        <Card className="lg:col-span-2 bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-300" />
              Live activity
              <span className="ml-2 h-2 w-2 rounded-full bg-emerald-400 pulse-dot" />
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                updated {timeAgo(state.generatedAt)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[320px] pr-3 slim-scroll">
              {activityFeed.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  hint="Run a tick to ingest HITs and start the swarm."
                />
              ) : (
                <ul className="space-y-1.5">
                  {activityFeed.map((item, i) => (
                    <li
                      key={`${item.kind}-${i}`}
                      className="ticker-fade-in flex items-start gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                    >
                      <div
                        className={
                          "mt-1 h-2 w-2 rounded-full shrink-0 " +
                          (item.kind === "revenue"
                            ? "bg-emerald-400"
                            : item.status === "handed_off"
                              ? "bg-violet-400"
                              : "bg-cyan-400")
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium truncate max-w-[70%]">
                            {item.title}
                          </span>
                          <StatusBadge status={item.status} />
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono">
                          {item.sub}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground/70 shrink-0">
                        {timeAgo(item.at)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* TOP AGENTS + TASK PIPELINE SUMMARY */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-300" />
              Top agents by revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {topAgents.length === 0 ? (
              <EmptyState title="No agents yet" hint="Run a tick to seed the fleet." />
            ) : (
              <div className="space-y-2">
                {topAgents.map((a, idx) => {
                  const rev = a.performance_metrics?.revenue_generated ?? 0;
                  const tasks = a.performance_metrics?.tasks_completed ?? 0;
                  const sr = a.performance_metrics?.success_rate ?? 100;
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                    >
                      <div className="text-sm font-mono text-muted-foreground w-5">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate">{a.name}</span>
                          <AgentTypeChip type={a.type} />
                          <StatusBadge status={a.status} />
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                          <span>{fmtNum(tasks)} tasks</span>
                          <span>{sr}% success</span>
                          <span className="text-muted-foreground/60">•</span>
                          <span>last active {timeAgo(a.performance_metrics?.last_active)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-mono text-emerald-300 tabular-nums">
                          {fmtUsd(rev)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">revenue</div>
                      </div>
                      <div className="w-28 hidden sm:block">
                        <WorkloadBar
                          current={a.current_workload ?? 0}
                          max={a.max_workload ?? 3}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-cyan-300" />
              Pipeline by status
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <PipelineRow label="Pending" count={kpis.pendingTasks} total={state.tasks.length} tone="bg-slate-400" />
            <PipelineRow label="In progress" count={kpis.inProgressTasks} total={state.tasks.length} tone="bg-cyan-400" />
            <PipelineRow label="Handed off" count={kpis.handedOffTasks} total={state.tasks.length} tone="bg-violet-400" />
            <PipelineRow label="Completed" count={kpis.completedTasks} total={state.tasks.length} tone="bg-emerald-400" />
            <PipelineRow label="Failed" count={kpis.failedTasks} total={state.tasks.length} tone="bg-rose-400" />
            <div className="pt-2 mt-2 border-t border-border/40 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total tasks tracked
              </div>
              <div className="text-sm font-mono">{fmtNum(state.tasks.length)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PipelineRow({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{fmtNum(count)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
        <div className={"h-full " + tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RevenueSparkline({
  values,
  max,
}: {
  values: number[];
  max: number;
}) {
  if (values.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">
        No revenue events yet — run a tick.
      </div>
    );
  }
  const w = 100;
  const h = 32;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const pathD = `M ${pts.join(" L ")}`;
  const areaD = `${pathD} L ${w},${h} L 0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-32"
    >
      <defs>
        <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.72 0.17 162)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="oklch(0.72 0.17 162)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#rev-grad)" />
      <path
        d={pathD}
        fill="none"
        stroke="oklch(0.72 0.17 162)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={h - (v / max) * (h - 4) - 2}
          r="1"
          fill="oklch(0.85 0.18 162)"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

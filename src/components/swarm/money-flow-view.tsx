"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Clock,
  CreditCard,
  Database,
  Landmark,
  Loader2,
  RefreshCw,
  Wallet,
  Zap,
} from "lucide-react";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtUsd,
  timeAgo,
} from "./primitives";

// ─── Types ──────────────────────────────────────────────────────────

interface MoneyFlowData {
  ok: boolean;
  dashboard: {
    title: string;
    flow: {
      step_1_revenue: FlowStep;
      step_2_verified: FlowStep;
      step_3_ledger: LedgerStep;
      step_4_payout: PayoutStep;
      step_5_settlement: SettlementStep;
      step_6_bank: FlowStep;
    };
    summary: {
      gross_revenue: number;
      verified: number;
      in_ledger: number;
      in_transit: number;
      bank_received: number;
      owner_action_needed: number;
      stuck_amount: number;
    };
    webhooks: {
      total_received: number;
      recent: Array<{
        event_type: string;
        amount: number;
        status: string;
        received_at: string;
      }>;
    };
    health: {
      revenue_active: boolean;
      ledger_active: boolean;
      settlements_processing: boolean;
      bank_receiving: boolean;
      owner_action_required: boolean;
      overall: string;
    };
  };
  timestamp: string;
}

interface FlowStep {
  label: string;
  amount: number;
  count: number;
  status: string;
}

interface LedgerStep {
  label: string;
  by_type: Record<string, number>;
  total_entries: number;
  status: string;
}

interface PayoutStep {
  label: string;
  by_status: Record<string, number>;
  total_batches: number;
  status: string;
}

interface SettlementStep {
  label: string;
  by_status: Record<string, number>;
  total_items: number;
  status: string;
}

// ─── Status Colors ──────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  idle: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  empty: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  awaiting: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  owner_action_required: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

// ─── Main View ──────────────────────────────────────────────────────

export function MoneyFlowView() {
  const [data, setData] = useState<MoneyFlowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/money-flow", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MoneyFlowData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <div className="text-sm text-muted-foreground">Loading money flow…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-rose-300" />
        <div className="text-sm font-medium">Couldn't load money flow</div>
        <div className="text-xs text-muted-foreground max-w-md">{error}</div>
        <Button size="sm" variant="outline" onClick={refresh}>
          <RefreshCw className="h-3 w-3 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const { flow, summary, webhooks, health } = data.dashboard;

  return (
    <div className="space-y-6">
      {/* ─── HEALTH BANNER ─── */}
      <Card
        className={
          health.overall === "healthy"
            ? "bg-emerald-500/5 border-emerald-500/30"
            : health.overall === "initializing"
              ? "bg-amber-500/5 border-amber-500/30"
              : "bg-rose-500/5 border-rose-500/30"
        }
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <span
              className={`h-3 w-3 rounded-full ${
                health.overall === "healthy"
                  ? "bg-emerald-400 pulse-dot"
                  : health.overall === "initializing"
                    ? "bg-amber-400"
                    : "bg-rose-400"
              }`}
            />
            <div className="flex-1">
              <div className="text-sm font-medium">
                {health.overall === "healthy"
                  ? "Money flow is healthy"
                  : health.overall === "initializing"
                    ? "Money flow is initializing — waiting for PSP activation"
                    : "Money flow has issues"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {health.owner_action_required
                  ? "Owner action required for settlement"
                  : health.bank_receiving
                    ? "Bank is receiving settlements"
                    : "Awaiting first bank settlement"}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={refresh}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─── KPI ROW ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Gross Revenue"
          value={fmtUsd(summary.gross_revenue)}
          delta={`${flow.step_1_revenue.count} events`}
          icon={Zap}
          accent="emerald"
        />
        <KpiCard
          label="In Transit"
          value={fmtUsd(summary.in_transit)}
          delta={`${flow.step_4_payout.total_batches} batches`}
          icon={Clock}
          accent="amber"
        />
        <KpiCard
          label="Bank Received"
          value={fmtUsd(summary.bank_received)}
          delta={`${flow.step_6_bank.count} credits`}
          icon={Landmark}
          accent="teal"
        />
        <KpiCard
          label="Owner Action"
          value={summary.owner_action_needed}
          delta={`${summary.stuck_amount > 0 ? fmtUsd(summary.stuck_amount) + " stuck" : "clear"}`}
          icon={AlertTriangle}
          accent={summary.owner_action_needed > 0 ? "rose" : "violet"}
        />
      </div>

      {/* ─── FLOW VISUALIZATION ─── */}
      <Card className="bg-card/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ArrowRight className="h-4 w-4 text-primary" />
            Money Flow Pipeline
            <Badge
              variant="outline"
              className={`ml-auto text-[9px] font-mono ${STATUS_COLORS[health.overall] || STATUS_COLORS.idle}`}
            >
              {health.overall}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <FlowNode
              step={flow.step_1_revenue}
              icon={Zap}
              color="emerald"
              number={1}
            />
            <FlowArrow />
            <FlowNode
              step={flow.step_2_verified}
              icon={CheckCircle2}
              color="teal"
              number={2}
            />
            <FlowArrow />
            <FlowNode
              step={{ label: flow.step_3_ledger.label, amount: flow.step_3_ledger.by_type.payable || 0, count: flow.step_3_ledger.total_entries, status: flow.step_3_ledger.status }}
              icon={Database}
              color="violet"
              number={3}
            />
            <FlowArrow />
            <FlowNode
              step={{ label: flow.step_4_payout.label, amount: flow.step_4_payout.by_status.submitted || 0, count: flow.step_4_payout.total_batches, status: flow.step_4_payout.status }}
              icon={Banknote}
              color="amber"
              number={4}
            />
            <FlowArrow />
            <FlowNode
              step={{ label: flow.step_5_settlement.label, amount: 0, count: flow.step_5_settlement.total_items, status: flow.step_5_settlement.status }}
              icon={CreditCard}
              color={flow.step_5_settlement.status === "owner_action_required" ? "rose" : "violet"}
              number={5}
            />
            <FlowArrow />
            <FlowNode
              step={flow.step_6_bank}
              icon={Landmark}
              color="teal"
              number={6}
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── LEDGER BREAKDOWN ─── */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-violet-300" />
              Unified Ledger
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                {flow.step_3_ledger.total_entries} entries
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2">
              {Object.entries(flow.step_3_ledger.by_type).map(([type, amount]) => (
                <div key={type} className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px] font-mono capitalize">
                      {type.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <span className="font-mono text-sm tabular-nums">{fmtUsd(amount)}</span>
                </div>
              ))}
              {Object.keys(flow.step_3_ledger.by_type).length === 0 && (
                <EmptyState title="No ledger entries" hint="Revenue will appear here once recorded." />
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wallet className="h-4 w-4 text-amber-300" />
              Settlement Queue
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                {flow.step_5_settlement.total_items} items
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2">
              {Object.entries(flow.step_5_settlement.by_status).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[9px] font-mono ${STATUS_COLORS[status] || STATUS_COLORS.idle}`}
                    >
                      {status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <span className="font-mono text-sm tabular-nums">{count}</span>
                </div>
              ))}
              {Object.keys(flow.step_5_settlement.by_status).length === 0 && (
                <EmptyState title="No settlement items" hint="Settlements will appear here once initiated." />
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── RECENT WEBHOOKS ─── */}
      <Card className="bg-card/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-cyan-300" />
            Recent Webhooks
            <span className="ml-auto text-[10px] text-muted-foreground font-normal">
              {webhooks.total_received} received
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ScrollArea className="h-[200px] slim-scroll">
            {webhooks.recent.length === 0 ? (
              <EmptyState
                title="No webhooks received"
                hint="ChariBaaS will send payment notifications here."
              />
            ) : (
              <ul className="space-y-1.5">
                {webhooks.recent.map((wh, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                  >
                    <Badge variant="outline" className="text-[9px] font-mono">
                      {wh.event_type}
                    </Badge>
                    <span className="font-mono text-xs">{fmtUsd(wh.amount)}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] font-mono ${
                        wh.status === "COMPLETED"
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                      }`}
                    >
                      {wh.status}
                    </Badge>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {timeAgo(wh.received_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Flow Node ──────────────────────────────────────────────────────

function FlowNode({
  step,
  icon: Icon,
  color,
  number,
}: {
  step: FlowStep;
  icon: React.ElementType;
  color: string;
  number: number;
}) {
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-500/30 bg-emerald-500/5",
    cyan: "border-cyan-500/30 bg-cyan-500/5",
    violet: "border-violet-500/30 bg-violet-500/5",
    amber: "border-amber-500/30 bg-amber-500/5",
    rose: "border-rose-500/30 bg-rose-500/5",
    teal: "border-teal-500/30 bg-teal-500/5",
    slate: "border-slate-500/30 bg-slate-500/5",
  };

  const iconColorMap: Record<string, string> = {
    emerald: "text-emerald-300",
    cyan: "text-cyan-300",
    violet: "text-violet-300",
    amber: "text-amber-300",
    rose: "text-rose-300",
    teal: "text-teal-300",
    slate: "text-slate-300",
  };

  return (
    <div className={`rounded-lg border p-3 ${colorMap[color] || colorMap.violet}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-mono text-muted-foreground">#{number}</span>
        <Icon className={`h-3.5 w-3.5 ${iconColorMap[color] || iconColorMap.violet}`} />
        <Badge
          variant="outline"
          className={`text-[8px] font-mono ml-auto ${STATUS_COLORS[step.status] || STATUS_COLORS.idle}`}
        >
          {step.status}
        </Badge>
      </div>
      <div className="text-[11px] font-medium text-foreground/80 truncate">{step.label}</div>
      <div className="text-lg font-mono font-semibold tabular-nums mt-1">{fmtUsd(step.amount)}</div>
      <div className="text-[10px] text-muted-foreground">{step.count} items</div>
    </div>
  );
}

// ─── Flow Arrow ─────────────────────────────────────────────────────

function FlowArrow() {
  return (
    <div className="hidden md:flex items-center justify-center">
      <ArrowRight className="h-4 w-4 text-muted-foreground/40" />
    </div>
  );
}

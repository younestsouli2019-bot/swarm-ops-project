"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CircleDollarSign, Fingerprint, ShieldCheck, TrendingUp } from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtUsd,
  timeAgo,
} from "./primitives";

export function RevenueView({ state }: { state: SwarmState }) {
  const { revenueStreams, revenueEvents, kpis } = state;

  // ── Settlement Ledger isolation rule ──────────────────────────────────
  // HARD RULE: revenue view headline = cryptographically-settled only.
  const settledCents = kpis.settledCents ?? 0;
  const hasReceipt = (kpis.settledEntryCount ?? 0) > 0 && settledCents > 0;
  const pipelineCents =
    (kpis.pipelinePendingCents ?? 0) + (kpis.pipelineSpeculativeCents ?? 0);

  const grouped = {
    confirmed: revenueEvents.filter((e) => e.status === "confirmed"),
    paid_out: revenueEvents.filter((e) => e.status === "paid_out"),
    projected: revenueEvents.filter((e) => e.status === "projected"),
    cancelled: revenueEvents.filter((e) => e.status === "cancelled"),
  };

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
                  ? "Cryptographically settled balance (oracle-verified)"
                  : "HARD RULE: $0.00 settled — no receipt_hash verified yet"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {hasReceipt
                  ? `${kpis.settledEntryCount} entries passed 2PC commit · receipt_hash bound`
                  : `Pipeline holds ${fmtUsd(pipelineCents, { fromCents: true })} in SPECULATIVE + PENDING_SETTLEMENT states — never displayed as real revenue.`}
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
          label="Pipeline (zero weight)"
          value={fmtUsd(pipelineCents, { fromCents: true })}
          delta={`pending ${kpis.pipelinePendingCents ?? 0}c · speculative ${kpis.pipelineSpeculativeCents ?? 0}c`}
          icon={TrendingUp}
          accent="amber"
        />
        <KpiCard
          label="Confirmed revenue (legacy)"
          value={fmtUsd(kpis.confirmedRevenue)}
          delta="awaiting 2PC prepare + commit"
          icon={CircleDollarSign}
          accent="violet"
        />
        <KpiCard
          label="Total events"
          value={revenueEvents.length}
          delta={`${grouped.confirmed.length} confirmed • ${grouped.paid_out.length} paid`}
          icon={TrendingUp}
          accent="teal"
        />
      </div>

      <SectionHeader
        title="Revenue streams"
        subtitle="Each stream is a configured revenue channel with a monthly target and a payout cadence."
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {revenueStreams.length === 0 ? (
          <Card className="bg-card/60 col-span-full">
            <CardContent>
              <EmptyState
                title="No revenue streams"
                hint="Run a tick to provision the default HIT Marketplace Rewards stream."
              />
            </CardContent>
          </Card>
        ) : (
          revenueStreams.map((s) => {
            const target = s.target_monthly_revenue ?? 0;
            const available = s.available_for_payout ?? 0;
            const pct = target > 0 ? Math.min(100, (available / target) * 100) : 0;
            return (
              <Card key={s.id} className="bg-card/60">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{s.name}</div>
                      <Badge
                        variant="outline"
                        className="mt-1 text-[10px] font-mono bg-background/40"
                      >
                        {s.type.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-md bg-background/40 py-1.5">
                      <div className="text-[9px] uppercase text-muted-foreground">
                        Target / mo
                      </div>
                      <div className="text-sm font-mono">{fmtUsd(target)}</div>
                    </div>
                    <div className="rounded-md bg-background/40 py-1.5">
                      <div className="text-[9px] uppercase text-muted-foreground">
                        Available
                      </div>
                      <div className="text-sm font-mono text-emerald-300">
                        {fmtUsd(available)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                      <span>Progress to target</span>
                      <span>{Math.round(pct)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-background/60 overflow-hidden">
                      <div
                        className="h-full bg-emerald-400"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Payout: <StatusBadge status={s.payout_status || "idle"} /></span>
                    <span>last: {timeAgo(s.last_payout_date)}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <SectionHeader title="Revenue event ledger" subtitle="Every dollar earned by the swarm, newest first." />

      <Card className="bg-card/60">
        <CardContent className="p-0">
          <ScrollArea className="max-h-[560px] slim-scroll">
            {revenueEvents.length === 0 ? (
              <EmptyState
                title="No revenue events yet"
                hint="Run a tick to start completing HITs and booking revenue."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2 px-3">Event</th>
                    <th className="py-2 px-3">Source</th>
                    <th className="py-2 px-3">Amount</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {revenueEvents.map((e) => (
                    <tr
                      key={e.id}
                      className="border-b border-border/20 hover:bg-background/30"
                    >
                      <td className="py-2 px-3 max-w-md">
                        <div className="font-medium text-xs truncate">
                          {e.description || e.event_id}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {e.event_id}
                          {(e.metadata as { agent_name?: string })?.agent_name
                            ? ` • agent: ${(e.metadata as { agent_name?: string }).agent_name}`
                            : ""}
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <Badge
                          variant="outline"
                          className="text-[10px] font-mono bg-background/40"
                        >
                          {e.source.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="py-2 px-3 font-mono text-emerald-300">
                        {fmtUsd(e.amount)}
                      </td>
                      <td className="py-2 px-3">
                        <StatusBadge status={e.status} />
                      </td>
                      <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap">
                        {timeAgo(e.created_date || e.confirmation_date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Banknote, CircleDollarSign } from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtNum,
  fmtUsd,
  timeAgo,
} from "./primitives";

export function PayoutsView({ state }: { state: SwarmState }) {
  const { payoutBatches, payoutItems, payoutRecipients, kpis } = state;
  const totalPaid = payoutBatches.reduce((s, b) => s + (b.total_amount ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Total paid out"
          value={fmtUsd(totalPaid)}
          delta={`${payoutBatches.length} batch(es)`}
          icon={Banknote}
          accent="teal"
        />
        <KpiCard
          label="Open batches"
          value={fmtNum(kpis.openPayoutBatches)}
          delta="awaiting completion"
          icon={CircleDollarSign}
          accent="amber"
        />
        <KpiCard
          label="Payout items"
          value={fmtNum(payoutItems.length)}
          delta={`${payoutItems.filter((i) => i.status === "success").length} succeeded`}
          icon={Banknote}
          accent="emerald"
        />
        <KpiCard
          label="Recipients"
          value={fmtNum(payoutRecipients.length)}
          delta={`${payoutRecipients.filter((r) => r.is_default).length} default`}
          icon={CircleDollarSign}
          accent="violet"
        />
      </div>

      <SectionHeader
        title="Payout batches"
        subtitle="When confirmed revenue crosses $25 on a stream, the orchestrator sweeps it into a payout batch."
      />

      <Card className="bg-card/60">
        <CardContent className="p-0">
          <ScrollArea className="max-h-[440px] slim-scroll">
            {payoutBatches.length === 0 ? (
              <EmptyState
                title="No payouts yet"
                hint="Keep the swarm running — once available revenue crosses $25 a batch will be created automatically."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2 px-3">Batch</th>
                    <th className="py-2 px-3">Amount</th>
                    <th className="py-2 px-3">Items</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Notes</th>
                    <th className="py-2 px-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutBatches.map((b) => (
                    <tr
                      key={b.id}
                      className="border-b border-border/20 hover:bg-background/30"
                    >
                      <td className="py-2 px-3 font-mono text-xs">
                        {b.batch_id || b.id?.slice(-8)}
                      </td>
                      <td className="py-2 px-3 font-mono text-emerald-300">
                        {fmtUsd(b.total_amount ?? 0)}{" "}
                        <span className="text-[10px] text-muted-foreground">
                          {b.currency}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono">
                        {fmtNum(b.item_count ?? 0)}
                      </td>
                      <td className="py-2 px-3">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="py-2 px-3 text-[11px] text-muted-foreground max-w-md truncate">
                        {b.notes || "—"}
                      </td>
                      <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap">
                        {timeAgo(b.created_date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Recent payout items</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="max-h-72 slim-scroll">
              {payoutItems.length === 0 ? (
                <EmptyState title="No items yet" />
              ) : (
                <ul className="space-y-1.5">
                  {payoutItems.slice(0, 20).map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">
                          {it.recipient_name || it.recipient}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {it.item_id} • {it.recipient_type.replace(/_/g, " ")}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-mono text-emerald-300">
                          {fmtUsd(it.amount)}
                        </div>
                        <StatusBadge status={it.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Payout recipients</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {payoutRecipients.length === 0 ? (
              <EmptyState title="No recipients configured" />
            ) : (
              <ul className="space-y-1.5">
                {payoutRecipients.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate flex items-center gap-2">
                        {r.name}
                        {r.is_default && (
                          <Badge className="text-[9px] bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                            default
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {r.recipient_type.replace(/_/g, " ")} • {r.currency} • {r.account_identifier}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-muted-foreground">
                        {r.country || "—"}
                      </div>
                      {r.bank_name && (
                        <div className="text-[10px] text-muted-foreground/70">
                          {r.bank_name}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

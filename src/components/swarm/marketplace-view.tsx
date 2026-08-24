"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { CircleDollarSign, Clock, Download, Store } from "./icons";
import type { HIT } from "@/lib/hit-market";
import { useIngestHits, usePreviewHits } from "./hooks";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  fmtNum,
  fmtUsd,
} from "./primitives";

const MARKETPLACE_TONE: Record<HIT["marketplace"], string> = {
  mturk: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  clickworker: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  toloka: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  prolific: "bg-violet-500/10 text-violet-300 border-violet-500/30",
  internal: "bg-slate-500/10 text-slate-300 border-slate-500/30",
};

export function MarketplaceView() {
  const preview = usePreviewHits();
  const ingest = useIngestHits();

  const hits = preview.data?.hits ?? [];

  const stats = useMemo(() => {
    const total = hits.length;
    const totalReward = hits.reduce(
      (s, h) => s + h.reward_cents * h.assignments,
      0
    );
    const byMarket = new Map<string, number>();
    for (const h of hits) {
      byMarket.set(h.marketplace, (byMarket.get(h.marketplace) ?? 0) + 1);
    }
    const avgReward = total > 0 ? totalReward / total / 100 : 0;
    return {
      total,
      totalReward,
      byMarket: Array.from(byMarket.entries()).sort((a, b) => b[1] - a[1]),
      avgReward,
    };
  }, [hits]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Open HITs in feed"
          value={fmtNum(stats.total)}
          delta="live preview"
          icon={Store}
          accent="emerald"
        />
        <KpiCard
          label="Avg reward"
          value={fmtUsd(stats.avgReward)}
          delta="per HIT, weighted"
          icon={CircleDollarSign}
          accent="amber"
        />
        <KpiCard
          label="Gross reward"
          value={fmtUsd(stats.totalReward, { fromCents: true })}
          delta="if all assignments completed"
          icon={CircleDollarSign}
          accent="teal"
        />
        <KpiCard
          label="Marketplaces"
          value={fmtNum(stats.byMarket.length)}
          delta={stats.byMarket.map((m) => m[0]).join(", ") || "—"}
          icon={Store}
          accent="violet"
        />
      </div>

      <SectionHeader
        title="HIT marketplace feed"
        subtitle="A live preview of Human Intelligence Tasks available on the crowdsourcing marketplace. The orchestrator pulls these into the Task pipeline on every tick."
        right={
          <Button
            size="sm"
            className="h-9"
            disabled={ingest.isPending}
            onClick={() => ingest.mutate()}
          >
            <Download className="h-4 w-4 mr-1.5" />
            {ingest.isPending ? "Ingesting…" : "Ingest HITs now"}
          </Button>
        }
      />

      {/* marketplace distribution */}
      {stats.byMarket.length > 0 && (
        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Distribution by marketplace</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {stats.byMarket.map(([market, count]) => (
                <div
                  key={market}
                  className={
                    "rounded-md border px-3 py-1.5 text-xs font-mono flex items-center gap-2 " +
                    (MARKETPLACE_TONE[market as HIT["marketplace"]] ||
                      "bg-slate-500/10 text-slate-300 border-slate-500/30")
                  }
                >
                  <span className="uppercase">{market}</span>
                  <span className="opacity-60">·</span>
                  <span>{count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {hits.length === 0 ? (
          <Card className="bg-card/60 col-span-full">
            <CardContent>
              <EmptyState
                title="No HITs in the feed"
                hint="The feed refreshes every 15s — hang tight."
              />
            </CardContent>
          </Card>
        ) : (
          hits.map((h) => (
            <Card
              key={h.hit_id}
              className="bg-card/60 border-border/60 hover:border-primary/40 transition-colors"
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <Badge
                    variant="outline"
                    className={
                      "text-[10px] font-mono uppercase " +
                      (MARKETPLACE_TONE[h.marketplace] ||
                        "bg-slate-500/10 text-slate-300 border-slate-500/30")
                    }
                  >
                    {h.marketplace}
                  </Badge>
                  <div className="text-right">
                    <div className="text-sm font-mono text-emerald-300">
                      {fmtUsd(h.reward_cents, { fromCents: true })}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      × {h.assignments} asg
                    </div>
                  </div>
                </div>

                <div className="mt-2 font-medium text-sm leading-snug">{h.title}</div>
                <p className="mt-1 text-[11px] text-muted-foreground line-clamp-3">
                  {h.description}
                </p>

                <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="truncate max-w-[60%]">{h.requester}</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    ~{h.est_minutes} min
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-1">
                  {h.keywords.slice(0, 4).map((k) => (
                    <span
                      key={k}
                      className="text-[9px] font-mono rounded bg-background/40 border border-border/40 px-1.5 py-0.5"
                    >
                      #{k}
                    </span>
                  ))}
                </div>

                <div className="mt-2 text-[10px] text-muted-foreground font-mono">
                  {h.hit_id} • type: {h.task_type.replace(/_/g, " ")} → agent:{" "}
                  {h.agent_type.replace(/_/g, " ")}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

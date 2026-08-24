"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowRight, WorkflowIcon } from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtNum,
  timeAgo,
} from "./primitives";

export function WorkflowsView({ state }: { state: SwarmState }) {
  const { workflows } = state;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Total workflows"
          value={fmtNum(workflows.length)}
          icon={WorkflowIcon}
          accent="violet"
        />
        <KpiCard
          label="Active"
          value={fmtNum(workflows.filter((w) => w.status === "active").length)}
          icon={WorkflowIcon}
          accent="emerald"
        />
        <KpiCard
          label="Drafts"
          value={fmtNum(workflows.filter((w) => w.status === "draft").length)}
          icon={WorkflowIcon}
          accent="amber"
        />
        <KpiCard
          label="Paused / Archived"
          value={fmtNum(
            workflows.filter((w) => w.status === "paused" || w.status === "archived").length
          )}
          icon={WorkflowIcon}
          accent="rose"
        />
      </div>

      <SectionHeader
        title="Workflows"
        subtitle="Reusable node-graphs the orchestrator executes. Each workflow ties HIT ingestion, dispatch, processing, and payout together."
      />

      {workflows.length === 0 ? (
        <Card className="bg-card/60">
          <CardContent>
            <EmptyState
              title="No workflows defined"
              hint="Run a tick to provision the default HIT pipeline workflow."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-1 gap-3">
          {workflows.map((w) => (
            <Card key={w.id} className="bg-card/60">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <CardTitle className="text-base font-medium">{w.name}</CardTitle>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono bg-background/40"
                      >
                        {w.category.replace(/_/g, " ")}
                      </Badge>
                      <StatusBadge status={w.status} />
                    </div>
                  </div>
                  <div className="text-right text-[10px] text-muted-foreground">
                    <div>
                      runs:{" "}
                      {fmtNum(
                        (w.execution_stats as { runs?: number })?.runs ?? 0
                      )}
                    </div>
                    <div>
                      last:{" "}
                      {timeAgo(
                        (w.execution_stats as { last_run?: string })?.last_run
                      )}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-1">
                {w.description && (
                  <p className="text-[11px] text-muted-foreground mb-3">
                    {w.description}
                  </p>
                )}
                {Array.isArray(w.nodes) && w.nodes.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {w.nodes.map((n, idx) => {
                      const node = n as {
                        id?: string;
                        type?: string;
                        next?: string | null;
                      };
                      return (
                        <div key={idx} className="flex items-center gap-1.5">
                          <div className="rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs font-mono">
                            <span className="text-muted-foreground text-[10px]">
                              {idx + 1}.
                            </span>{" "}
                            <span className="text-foreground">{node.type || node.id}</span>
                          </div>
                          {node.next && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                        </div>
                      );
                    })}
                  </div>
                )}
                {w.trigger && (
                  <div className="mt-3 text-[10px] text-muted-foreground">
                    <span className="font-mono">trigger:</span>{" "}
                    <span className="font-mono">
                      {JSON.stringify(w.trigger)}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

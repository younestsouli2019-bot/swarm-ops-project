"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CircleDollarSign, ListChecks, Search } from "./icons";
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

export function PipelineView({ state }: { state: SwarmState }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [type, setType] = useState<string>("all");

  const tasks = useMemo(() => {
    return state.tasks.filter((t) => {
      if (status !== "all" && t.status !== status) return false;
      if (type !== "all" && t.type !== type) return false;
      if (q) {
        const hay = `${t.title} ${t.description || ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [state.tasks, q, status, type]);

  const types = Array.from(new Set(state.tasks.map((t) => t.type)));

  const totalReward = state.tasks.reduce((sum, t) => {
    const rd = (t.result_data || {}) as { total_reward_cents?: number; reward_cents?: number };
    return sum + (rd.total_reward_cents ?? rd.reward_cents ?? 0);
  }, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Open queue"
          value={fmtNum(state.kpis.pendingTasks + state.kpis.inProgressTasks)}
          delta={`${state.kpis.pendingTasks} pending • ${state.kpis.inProgressTasks} in progress`}
          icon={ListChecks}
          accent="emerald"
        />
        <KpiCard
          label="Completed"
          value={fmtNum(state.kpis.completedTasks)}
          delta={`${state.kpis.handedOffTasks} handed off • ${state.kpis.failedTasks} failed`}
          icon={ListChecks}
          accent="teal"
        />
        <KpiCard
          label="Gross reward tracked"
          value={fmtUsd(totalReward, { fromCents: true })}
          delta="across all tasks"
          icon={CircleDollarSign}
          accent="amber"
        />
        <KpiCard
          label="Total tasks"
          value={fmtNum(state.tasks.length)}
          icon={ListChecks}
          accent="violet"
        />
      </div>

      <SectionHeader
        title="HIT pipeline"
        subtitle="Each row is a HIT pulled from the marketplace, dispatched to a specialized agent, then completed (or handed off for QA)."
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tasks…"
                className="pl-8 h-9 w-48"
              />
            </div>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="in_progress">In progress</SelectItem>
                <SelectItem value="handed_off">Handed off</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <Card className="bg-card/60">
        <CardContent className="p-0">
          <ScrollArea className="max-h-[640px] slim-scroll">
            {tasks.length === 0 ? (
              <EmptyState
                title="No tasks match the filter"
                hint="Run a tick to ingest fresh HITs from the marketplace."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2 px-3">Title</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Reward</th>
                    <th className="py-2 px-3">Agent</th>
                    <th className="py-2 px-3">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => {
                    const rd = (t.result_data || {}) as {
                      hit_id?: string;
                      reward_cents?: number;
                      assignments?: number;
                      marketplace?: string;
                      requester?: string;
                      total_reward_cents?: number;
                    };
                    const reward =
                      rd.total_reward_cents ?? (rd.reward_cents ?? 0) * (rd.assignments ?? 1);
                    return (
                      <tr
                        key={t.id}
                        className="border-b border-border/20 hover:bg-background/30"
                      >
                        <td className="py-2 px-3 max-w-md">
                          <div className="font-medium text-xs truncate">{t.title}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {rd.hit_id ? `${rd.hit_id} • ` : ""}
                            {rd.marketplace ? `${rd.marketplace} • ` : ""}
                            {rd.requester ? rd.requester : ""}
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono bg-background/40"
                          >
                            {t.type.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="py-2 px-3">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="py-2 px-3 font-mono text-xs text-emerald-300">
                          {reward > 0 ? fmtUsd(reward, { fromCents: true }) : "—"}
                        </td>
                        <td className="py-2 px-3 text-[11px] font-mono text-muted-foreground">
                          {t.assigned_agent_id
                            ? t.assigned_agent_id.slice(-6)
                            : "—"}
                        </td>
                        <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap">
                          {timeAgo(t.updated_date || t.created_date)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

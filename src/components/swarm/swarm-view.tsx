"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  Gauge,
  Pause,
  Play,
  Search,
  Settings,
  Zap,
} from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import { useToggleAgent } from "./hooks";
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

const SWARM_AGENT_TYPES = [
  "data_analyst",
  "content_creator",
  "research_assistant",
  "lead_generator",
  "customer_service",
  "social_manager",
  "listing_bot",
  "design_generator",
  "seo_specialist",
  "workflow_automator",
  "devops",
  "vision",
  "document",
];

export function SwarmView({ state }: { state: SwarmState }) {
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const toggle = useToggleAgent();

  const agents = useMemo(() => {
    return state.swarmAgents.filter((a) => {
      if (typeFilter !== "all" && a.type !== typeFilter) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (q && !a.name.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [state.swarmAgents, q, typeFilter, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Swarm size"
          value={state.swarmAgents.length}
          delta={`${state.kpis.activeAgents} active • ${state.kpis.pausedAgents} paused`}
          icon={Bot}
          accent="violet"
        />
        <KpiCard
          label="Total revenue"
          value={fmtUsd(
            state.swarmAgents.reduce(
              (s, a) => s + (a.performance_metrics?.revenue_generated ?? 0),
              0
            )
          )}
          icon={Zap}
          accent="emerald"
        />
        <KpiCard
          label="Total tasks done"
          value={fmtNum(
            state.swarmAgents.reduce(
              (s, a) => s + (a.performance_metrics?.tasks_completed ?? 0),
              0
            )
          )}
          icon={Gauge}
          accent="teal"
        />
        <KpiCard
          label="Avg success"
          value={`${state.kpis.avgSuccessRate}%`}
          icon={Settings}
          accent="amber"
        />
      </div>

      <SectionHeader
        title="Swarm agents"
        subtitle="Autonomous agents that pull HITs from the marketplace, complete them, and book revenue."
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search agents…"
                className="pl-8 h-9 w-48"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {SWARM_AGENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="stopped">Stopped</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      {agents.length === 0 ? (
        <Card className="bg-card/60">
          <CardContent>
            <EmptyState
              title="No agents match the filter"
              hint="Try clearing the filters or running a tick to seed the fleet."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {agents.map((a) => {
            const rev = a.performance_metrics?.revenue_generated ?? 0;
            const tasks = a.performance_metrics?.tasks_completed ?? 0;
            const sr = a.performance_metrics?.success_rate ?? 100;
            const isActive = a.status === "active";
            return (
              <Card
                key={a.id}
                className="bg-card/60 border-border/60 hover:border-primary/40 transition-colors"
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{a.name}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="mt-1">
                        <AgentTypeChip type={a.type} />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={toggle.isPending && toggle.variables === a.id}
                      onClick={() => toggle.mutate(a.id!)}
                    >
                      {isActive ? (
                        <>
                          <Pause className="h-3 w-3 mr-1" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="h-3 w-3 mr-1" /> Resume
                        </>
                      )}
                    </Button>
                  </div>

                  <p className="mt-2 text-[11px] text-muted-foreground line-clamp-2">
                    {a.description || a.system_prompt}
                  </p>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-background/40 py-1.5">
                      <div className="text-[9px] uppercase text-muted-foreground">
                        Revenue
                      </div>
                      <div className="text-sm font-mono text-emerald-300">
                        {fmtUsd(rev)}
                      </div>
                    </div>
                    <div className="rounded-md bg-background/40 py-1.5">
                      <div className="text-[9px] uppercase text-muted-foreground">
                        Tasks
                      </div>
                      <div className="text-sm font-mono">{fmtNum(tasks)}</div>
                    </div>
                    <div className="rounded-md bg-background/40 py-1.5">
                      <div className="text-[9px] uppercase text-muted-foreground">
                        Success
                      </div>
                      <div className="text-sm font-mono">{sr}%</div>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Workload</span>
                        <span>last active {timeAgo(a.performance_metrics?.last_active)}</span>
                      </div>
                      <WorkloadBar
                        current={a.current_workload ?? 0}
                        max={a.max_workload ?? 3}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Capabilities</span>
                      <span className="font-mono">
                        {(a.capabilities || []).slice(0, 3).join(", ") || "—"}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Threshold rules */}
      <Card className="bg-card/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Autonomous threshold rules</CardTitle>
        </CardHeader>
        <CardContent>
          {state.thresholds.length === 0 ? (
            <EmptyState title="No threshold rules" hint="Run a tick to provision defaults." />
          ) : (
            <ScrollArea className="max-h-72 slim-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2 pr-4">Agent</th>
                    <th className="py-2 pr-4">Activate &gt;</th>
                    <th className="py-2 pr-4">Pause if success &lt;</th>
                    <th className="py-2 pr-4">Daily cost</th>
                    <th className="py-2 pr-4">Last action</th>
                    <th className="py-2 pr-4">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {state.thresholds.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-border/20 hover:bg-background/30"
                    >
                      <td className="py-2 pr-4 font-medium">{t.agent_name}</td>
                      <td className="py-2 pr-4 font-mono">
                        ${t.activate_above_revenue ?? 0}
                      </td>
                      <td className="py-2 pr-4 font-mono">
                        {t.min_success_rate ?? 0}%
                      </td>
                      <td className="py-2 pr-4 font-mono">${t.daily_cost ?? 0}</td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={t.last_action || "none"} />
                        <div className="text-[10px] text-muted-foreground">
                          {timeAgo(t.last_action_at)}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-[11px] text-muted-foreground max-w-xs truncate">
                        {t.last_action_reason || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

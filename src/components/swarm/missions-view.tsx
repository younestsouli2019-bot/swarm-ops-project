"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Plus, Rocket, Sparkles, Trophy } from "./icons";
import type { SwarmState } from "@/lib/orchestrator";
import { useCreateMission } from "./hooks";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtNum,
  fmtUsd,
  timeAgo,
} from "./primitives";

export function MissionsView({ state }: { state: SwarmState }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("revenue_generation");
  const [priority, setPriority] = useState<string>("medium");
  const [params, setParams] = useState<string>("{}");
  const create = useCreateMission();

  const sorted = [...state.missions].sort((a, b) => {
    // our seed mission first, then by updated_date desc
    const aSeed = a.mission_id === "HIT-OPS-001" ? 1 : 0;
    const bSeed = b.mission_id === "HIT-OPS-001" ? 1 : 0;
    if (aSeed !== bSeed) return bSeed - aSeed;
    return (b.updated_date || "") > (a.updated_date || "") ? 1 : -1;
  });

  async function handleCreate() {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(params || "{}");
    } catch {
      parsed = { raw: params };
    }
    await create.mutateAsync({
      title,
      type,
      priority,
      mission_parameters: parsed,
    });
    setTitle("");
    setParams("{}");
    setOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Active missions"
          value={fmtNum(state.missions.filter((m) => m.status === "in_progress").length)}
          delta={`${state.missions.length} total`}
          icon={Rocket}
          accent="emerald"
        />
        <KpiCard
          label="Mission revenue"
          value={fmtUsd(
            state.missions.reduce((s, m) => s + (m.revenue_generated ?? 0), 0)
          )}
          icon={Trophy}
          accent="amber"
        />
        <KpiCard
          label="Critical priority"
          value={fmtNum(state.missions.filter((m) => m.priority === "critical").length)}
          icon={Sparkles}
          accent="rose"
        />
        <KpiCard
          label="Completed"
          value={fmtNum(state.missions.filter((m) => m.status === "completed").length)}
          icon={Rocket}
          accent="violet"
        />
      </div>

      <SectionHeader
        title="Missions"
        subtitle="Top-level objectives assigned to the swarm. Each mission tracks revenue, assigned agents, and a step-by-step execution plan."
        right={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="h-9">
                <Plus className="h-4 w-4 mr-1.5" /> New mission
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create a mission</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="m-title">Title</Label>
                  <Input
                    id="m-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Q3 HIT Revenue Push"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Type</Label>
                    <Select value={type} onValueChange={setType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="revenue_generation">Revenue generation</SelectItem>
                        <SelectItem value="agent_deployment">Agent deployment</SelectItem>
                        <SelectItem value="market_expansion">Market expansion</SelectItem>
                        <SelectItem value="product_development">Product development</SelectItem>
                        <SelectItem value="financial_transaction">Financial transaction</SelectItem>
                        <SelectItem value="generative_enterprise">Generative enterprise</SelectItem>
                        <SelectItem value="api_key_distribution">API key distribution</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Priority</Label>
                    <Select value={priority} onValueChange={setPriority}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="m-params">Parameters (JSON)</Label>
                  <Textarea
                    id="m-params"
                    value={params}
                    onChange={(e) => setParams(e.target.value)}
                    className="font-mono text-xs h-24"
                    placeholder='{"target_revenue": 1000, "marketplaces": ["mturk"]}'
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!title || create.isPending}
                  onClick={handleCreate}
                >
                  {create.isPending ? "Creating…" : "Create mission"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid lg:grid-cols-2 gap-3">
        {sorted.map((m) => {
          const target =
            (m.mission_parameters as { target_monthly_revenue?: number })?.target_monthly_revenue ??
            (m.mission_id === "HIT-OPS-001" ? 5000 : 1000);
          const actual = m.revenue_generated ?? 0;
          const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
          return (
            <Card key={m.id} className="bg-card/60">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base font-medium truncate">
                      {m.title}
                    </CardTitle>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {m.mission_id}
                      </span>
                      <StatusBadge status={m.status} />
                      <StatusBadge status={m.priority} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono text-emerald-300">
                      {fmtUsd(actual)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      of {fmtUsd(target)}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-1 space-y-2">
                <Progress value={pct} className="h-1.5" />
                {m.execution_plan && m.execution_plan.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.execution_plan.map((step, idx) => {
                      const s = step as { action?: string; desc?: string };
                      return (
                        <span
                          key={idx}
                          className="text-[10px] font-mono rounded-md bg-background/40 border border-border/40 px-1.5 py-0.5"
                          title={s.desc}
                        >
                          {idx + 1}. {s.action || "?"}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>
                    {Array.isArray(m.assigned_agents) && m.assigned_agents.length > 0
                      ? `${m.assigned_agents.length} agent(s) assigned`
                      : "no agents assigned"}
                  </span>
                  <span>updated {timeAgo(m.updated_date)}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

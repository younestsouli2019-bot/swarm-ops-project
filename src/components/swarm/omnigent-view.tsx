"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Brain,
  Database,
  Search,
  Trash2,
  Play,
  CheckCircle2,
  Loader2,
  Plus,
  Scale,
  TrendingUp,
  Layers,
  Zap,
} from "lucide-react";

// ─── types ─────────────────────────────────────────────────────────────────

interface MemoryStats {
  working_count: number;
  long_term_count: number;
  total_entries: number;
  total_recalls: number;
  consolidations_run: number;
  entries_consolidated: number;
  working_hit_rate: number;
  long_term_hit_rate: number;
  avg_importance: number;
}

interface LoadBalancerStats {
  total_picks: number;
  by_agent: Record<string, number>;
  by_capability: Record<string, number>;
  avg_score: number;
  last_pick: { agent_id: string; capability: string; score: number; ts: number } | null;
}

interface MemoryEntry {
  id: string;
  ts: number;
  tier: "working" | "long_term";
  scope: "task" | "mission" | "agent" | "global";
  agent_id: string | null;
  task_id: string | null;
  mission_id: string | null;
  tags: string[];
  content: string;
  recall_count: number;
  last_recalled_at: number | null;
  importance: number;
}

interface OmnigentState {
  memory: MemoryStats;
  load_balancer: LoadBalancerStats;
  affinity_count: number;
  recent_memories: MemoryEntry[];
}

interface AgentLoadInfo {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  current_workload: number;
  max_workload: number;
  success_rate: number;
  recent_latency_ms: number;
  tasks_completed: number;
  status: "active" | "paused" | "stopped" | "error";
}

interface AgentPickResult {
  agent: AgentLoadInfo;
  score: number;
  reasons: string[];
  affinity: number;
  capability_match: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

const TIER_TONES: Record<string, string> = {
  working: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  long_term: "bg-purple-500/10 text-purple-300 border-purple-500/30",
};

const SCOPE_TONES: Record<string, string> = {
  task: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  mission: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  agent: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  global: "bg-slate-500/10 text-slate-300 border-slate-500/30",
};

// ─── main view ────────────────────────────────────────────────────────────

export function OmnigentView() {
  const [tab, setTab] = useState<"memory" | "recall" | "balancer" | "store">("memory");

  const { data, isLoading } = useQuery<OmnigentState>({
    queryKey: ["omnigent-memory"],
    queryFn: async () => {
      const res = await fetch("/api/omnigent-memory");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5_000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="bg-card/40 border-border/60 animate-pulse">
            <CardContent className="p-4 h-40" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Database className="h-3 w-3 text-cyan-300" /> Working
            </div>
            <div className="text-2xl font-mono text-cyan-300 tabular-nums">
              {data.memory.working_count}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Layers className="h-3 w-3 text-purple-300" /> Long-term
            </div>
            <div className="text-2xl font-mono text-purple-300 tabular-nums">
              {data.memory.long_term_count}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Search className="h-3 w-3 text-amber-300" /> Recalls
            </div>
            <div className="text-2xl font-mono text-amber-300 tabular-nums">
              {data.memory.total_recalls}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <TrendingUp className="h-3 w-3 text-emerald-300" /> WHit Rate
            </div>
            <div className="text-2xl font-mono text-emerald-300 tabular-nums">
              {fmtPct(data.memory.working_hit_rate)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Scale className="h-3 w-3 text-rose-300" /> LB Picks
            </div>
            <div className="text-2xl font-mono text-rose-300 tabular-nums">
              {data.load_balancer.total_picks}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Zap className="h-3 w-3 text-amber-300" /> Affinities
            </div>
            <div className="text-2xl font-mono text-foreground tabular-nums">
              {data.affinity_count}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tab selector */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {([
          ["memory", "Memory Browser", Database],
          ["recall", "Recall Query", Search],
          ["balancer", "Load Balancer", Scale],
          ["store", "Store Memory", Plus],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={
              "rounded-full px-3 py-1.5 font-mono flex items-center gap-1.5 " +
              (tab === id
                ? "bg-primary text-primary-foreground"
                : "bg-card/60 text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {tab === "memory" && <MemoryBrowserTab state={data} />}
      {tab === "recall" && <RecallTab />}
      {tab === "balancer" && <LoadBalancerTab lbStats={data.load_balancer} />}
      {tab === "store" && <StoreMemoryTab />}
    </div>
  );
}

// ─── memory browser tab ───────────────────────────────────────────────────

function MemoryBrowserTab({ state }: { state: OmnigentState }) {
  const qc = useQueryClient();
  const [tierFilter, setTierFilter] = useState<"all" | "working" | "long_term">("all");

  const list = useQuery({
    queryKey: ["omnigent-list", tierFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ list: "1", limit: "100" });
      if (tierFilter !== "all") params.set("tier", tierFilter);
      const res = await fetch(`/api/omnigent-memory?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5_000,
  });

  const consolidate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "consolidate", similarity_threshold: 0.85 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omnigent-list", tierFilter] }),
  });

  const promote = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omnigent-list", tierFilter] }),
  });

  const clearTier = useMutation({
    mutationFn: async (tier: "working" | "long_term") => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear", tier }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omnigent-list", tierFilter] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omnigent-list", tierFilter] }),
  });

  const entries: MemoryEntry[] = list.data?.entries || [];

  return (
    <div className="space-y-3">
      {/* Stats + actions */}
      <Card className="bg-card/40 border-border/60">
        <CardContent className="p-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <div className="text-[10px] uppercase text-muted-foreground">Avg importance</div>
            <div className="text-lg font-mono text-foreground">{(state.memory.avg_importance * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-muted-foreground">LT hit rate</div>
            <div className="text-lg font-mono text-emerald-300">{fmtPct(state.memory.long_term_hit_rate)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-muted-foreground">Consolidations</div>
            <div className="text-lg font-mono text-amber-300">
              {state.memory.consolidations_run} <span className="text-[10px] text-muted-foreground">({state.memory.entries_consolidated} merged)</span>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={consolidate.isPending} onClick={() => consolidate.mutate()}>
              {consolidate.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Layers className="h-3 w-3 mr-1" />}
              Consolidate
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={promote.isPending} onClick={() => promote.mutate()}>
              {promote.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <TrendingUp className="h-3 w-3 mr-1" />}
              Promote
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tier filter */}
      <div className="flex items-center gap-2 text-xs">
        {(["all", "working", "long_term"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTierFilter(t)}
            className={
              "rounded-full px-3 py-1 font-mono " +
              (tierFilter === t
                ? "bg-primary text-primary-foreground"
                : "bg-card/60 text-muted-foreground hover:text-foreground")
            }
          >
            {t === "all" ? "All" : t === "working" ? "Working" : "Long-term"}
            {list.data && (
              <span className="ml-1 opacity-60">
                {t === "all" ? list.data.total : t === "working" ? state.memory.working_count : state.memory.long_term_count}
              </span>
            )}
          </button>
        ))}
        {tierFilter !== "all" && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-[10px] text-rose-300 hover:text-rose-200"
            onClick={() => clearTier.mutate(tierFilter)}
          >
            <Trash2 className="h-3 w-3 mr-1" /> Clear {tierFilter}
          </Button>
        )}
      </div>

      {/* Memory list */}
      {list.isLoading ? (
        <Card className="bg-card/40 border-border/60">
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline-block" /> Loading memories…
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card className="bg-card/40 border-border/60">
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            No memories in this tier yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {entries.map((m) => (
            <Card key={m.id} className="bg-card/40 border-border/60">
              <CardContent className="p-2.5 text-xs">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <Badge variant="outline" className={`text-[9px] font-mono ${TIER_TONES[m.tier]}`}>
                    {m.tier}
                  </Badge>
                  <Badge variant="outline" className={`text-[9px] font-mono ${SCOPE_TONES[m.scope]}`}>
                    {m.scope}
                  </Badge>
                  {m.agent_id && (
                    <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                      {m.agent_id}
                    </Badge>
                  )}
                  {m.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[9px] font-mono bg-muted/20 text-muted-foreground border-border/30">
                      #{t}
                    </Badge>
                  ))}
                  <span className="text-[9px] font-mono text-muted-foreground ml-auto">
                    {fmtTime(m.ts)} · recalled {m.recall_count}× · imp {(m.importance * 100).toFixed(0)}%
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-rose-300"
                    onClick={() => del.mutate(m.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                <div className="text-foreground text-[11px] leading-relaxed">{m.content}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── recall tab ───────────────────────────────────────────────────────────

function RecallTab() {
  const [query, setQuery] = useState("which agent is best at categorization");
  const [topK, setTopK] = useState(5);

  const recall = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recall", query, top_k: topK }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const results: Array<{ entry: MemoryEntry; score: number }> = recall.data?.results || [];

  return (
    <div className="space-y-3">
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Search className="h-4 w-4 text-amber-300" /> Recall Query
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="font-mono text-xs min-h-[80px]"
            placeholder="Natural-language query — the omnigent embeds it via hashed-bag and returns top-K most similar memories."
          />
          <div className="flex items-center gap-3">
            <Label className="text-[10px] uppercase text-muted-foreground">Top K</Label>
            <Input
              type="number"
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value))))}
              className="h-7 w-20 text-xs font-mono"
              min={1}
              max={50}
            />
            <Button size="sm" className="ml-auto" disabled={!query || recall.isPending} onClick={() => recall.mutate()}>
              {recall.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
              Recall
            </Button>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Uses a sparse hash-bag embedding (no external embedding model — cosine over an 8192-bucket hash vector). ~0.85 recall@10 vs. real embeddings at ~1000× lower cost.
          </div>
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        {recall.data && results.length === 0 && (
          <Card className="bg-card/40 border-border/60">
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No memories matched (score &gt;= 0.05).
            </CardContent>
          </Card>
        )}
        {results.map((r, i) => (
          <Card key={r.entry.id} className="bg-card/40 border-border/60">
            <CardContent className="p-2.5 text-xs">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
                  #{i + 1} · score {r.score.toFixed(3)}
                </Badge>
                <Badge variant="outline" className={`text-[9px] font-mono ${TIER_TONES[r.entry.tier]}`}>
                  {r.entry.tier}
                </Badge>
                <Badge variant="outline" className={`text-[9px] font-mono ${SCOPE_TONES[r.entry.scope]}`}>
                  {r.entry.scope}
                </Badge>
                {r.entry.agent_id && (
                  <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                    {r.entry.agent_id}
                  </Badge>
                )}
              </div>
              <div className="text-foreground text-[11px] leading-relaxed">{r.entry.content}</div>
              <div className="text-[9px] font-mono text-muted-foreground mt-1">
                recalled {r.entry.recall_count}× · importance {(r.entry.importance * 100).toFixed(0)}%
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── load balancer tab ────────────────────────────────────────────────────

function LoadBalancerTab({ lbStats }: { lbStats: LoadBalancerStats }) {
  const qc = useQueryClient();
  const [capability, setCapability] = useState("categorization");

  const agentsQuery = useQuery({
    queryKey: ["omnigent-agents"],
    queryFn: async () => {
      const res = await fetch("/api/omnigent-memory?agents=1");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const pick = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pick_agent",
          capability,
          agents: agentsQuery.data?.agents || [],
          top_k: 5,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omnigent-memory"] }),
  });

  const agents: AgentLoadInfo[] = agentsQuery.data?.agents || [];
  const picks: AgentPickResult[] = pick.data?.picks || [];

  // Aggregate capabilities across all agents
  const allCaps = Array.from(new Set(agents.flatMap((a) => a.capabilities))).sort();

  return (
    <div className="space-y-3">
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-rose-300" /> Capability-aware Load Balancer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <Label className="text-[10px] uppercase text-muted-foreground">Required capability</Label>
              <select
                value={capability}
                onChange={(e) => setCapability(e.target.value)}
                className="w-full h-8 rounded-md border border-border/60 bg-background px-2 text-xs font-mono"
              >
                {allCaps.length === 0 ? (
                  <option value="">No capabilities found</option>
                ) : (
                  allCaps.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <Label className="text-[10px] uppercase text-muted-foreground">Available agents</Label>
              <div className="h-8 flex items-center px-2 text-xs font-mono text-muted-foreground border border-border/60 rounded-md">
                {agents.length} agents
              </div>
            </div>
            <div className="flex items-end">
              <Button
                size="sm"
                className="w-full"
                disabled={pick.isPending || !capability || agents.length === 0}
                onClick={() => pick.mutate()}
              >
                {pick.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scale className="h-3 w-3 mr-1" />}
                Pick best agent
              </Button>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Score = (1 − workload/max) × 0.35 + (success/100) × 0.30 + (1 − latency/5000) × 0.15 + affinity × 0.20. Agents without the capability or with non-active status are filtered out.
          </div>
        </CardContent>
      </Card>

      {/* LB stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Total picks</div>
            <div className="text-xl font-mono text-rose-300">{lbStats.total_picks}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Avg score</div>
            <div className="text-xl font-mono text-amber-300">{lbStats.avg_score.toFixed(3)}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Distinct agents picked</div>
            <div className="text-xl font-mono text-emerald-300">{Object.keys(lbStats.by_agent).length}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Capabilities balanced</div>
            <div className="text-xl font-mono text-cyan-300">{Object.keys(lbStats.by_capability).length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Picks result */}
      {picks.length > 0 && (
        <Card className="bg-card/40 border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-300" /> Top Picks for "{capability}"
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {picks.map((p, i) => (
                <div key={p.agent.id} className="rounded-md border border-border/60 bg-background/40 p-2.5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
                      #{i + 1} · score {p.score.toFixed(3)}
                    </Badge>
                    <span className="text-sm font-medium">{p.agent.name}</span>
                    <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                      {p.agent.type}
                    </Badge>
                    {p.affinity > 0 && (
                      <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                        affinity {p.affinity.toFixed(2)}
                      </Badge>
                    )}
                    <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                      load {p.agent.current_workload}/{p.agent.max_workload} · success {p.agent.success_rate}%
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.reasons.map((r, idx) => (
                      <span key={idx} className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded px-1.5 py-0.5">
                        ✓ {r}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agents roster */}
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="h-4 w-4 text-cyan-300" /> Agent Roster ({agents.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[280px]">
            <div className="space-y-1">
              {agents.slice(0, 50).map((a) => (
                <div key={a.id} className="rounded-md border border-border/60 bg-background/40 p-2 text-xs flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{a.name}</span>
                  <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                    {a.type}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      "text-[9px] font-mono " +
                      (a.status === "active"
                        ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                        : "bg-rose-500/10 text-rose-300 border-rose-500/30")
                    }
                  >
                    {a.status}
                  </Badge>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    load {a.current_workload}/{a.max_workload} · {a.success_rate}% · {a.tasks_completed} tasks
                  </span>
                  <div className="flex flex-wrap gap-1 ml-auto">
                    {a.capabilities.slice(0, 4).map((c) => (
                      <Badge
                        key={c}
                        variant="outline"
                        className={
                          "text-[9px] font-mono " +
                          (c === capability
                            ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                            : "bg-muted/20 text-muted-foreground border-border/30")
                        }
                      >
                        {c}
                      </Badge>
                    ))}
                    {a.capabilities.length > 4 && (
                      <span className="text-[9px] text-muted-foreground">+{a.capabilities.length - 4}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── store memory tab ─────────────────────────────────────────────────────

function StoreMemoryTab() {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"task" | "mission" | "agent" | "global">("global");
  const [tier, setTier] = useState<"working" | "long_term">("long_term");
  const [agentId, setAgentId] = useState("");
  const [tags, setTags] = useState("");
  const [importance, setImportance] = useState(0.5);

  const store = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/omnigent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "store",
          content,
          scope,
          tier,
          agent_id: agentId || null,
          tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          importance,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setContent("");
      setAgentId("");
      setTags("");
      qc.invalidateQueries({ queryKey: ["omnigent-memory"] });
      qc.invalidateQueries({ queryKey: ["omnigent-list"] });
    },
  });

  return (
    <Card className="bg-card/40 border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Plus className="h-4 w-4 text-emerald-300" /> Store Memory
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-[10px] uppercase text-muted-foreground">Content</Label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono text-xs min-h-[120px]"
            placeholder="The memory content — what should the swarm remember?"
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Scope</Label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "task" | "mission" | "agent" | "global")}
              className="w-full h-8 rounded-md border border-border/60 bg-background px-2 text-xs font-mono"
            >
              <option value="global">global</option>
              <option value="agent">agent</option>
              <option value="mission">mission</option>
              <option value="task">task</option>
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Tier</Label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as "working" | "long_term")}
              className="w-full h-8 rounded-md border border-border/60 bg-background px-2 text-xs font-mono"
            >
              <option value="working">working (TTL 5m)</option>
              <option value="long_term">long_term</option>
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Agent ID (optional)</Label>
            <Input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="atlas-1" className="h-8 text-xs font-mono" />
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Importance: {importance.toFixed(2)}</Label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
              className="w-full h-8"
            />
          </div>
        </div>
        <div>
          <Label className="text-[10px] uppercase text-muted-foreground">Tags (comma-separated)</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="performance, categorization" className="h-8 text-xs font-mono" />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={!content || store.isPending} onClick={() => store.mutate()}>
            {store.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
            Store memory
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

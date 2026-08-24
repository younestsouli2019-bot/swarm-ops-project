"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Cpu,
  Zap,
  Sparkles,
  Code2,
  Network,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  ExternalLink,
} from "lucide-react";

// ─── types ─────────────────────────────────────────────────────────────────

interface OptimizationRecord {
  id: string;
  ts: number;
  category: string;
  description: string;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
  model_id: string;
  applied: boolean;
  metadata?: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  registered_at: number;
  last_call_at: number | null;
  call_count: number;
  tools: McpTool[];
}

interface AiSuggestion {
  id: string;
  ts: number;
  category: string;
  title: string;
  description: string;
  confidence: number;
  est_tokens_saved: number;
  before_preview: string;
  after_preview: string;
  applied: boolean;
  model_id: string;
}

interface TokenOptimizerState {
  optimizations: OptimizationRecord[];
  mcp_servers: McpServerConfig[];
  ai_suggestions: AiSuggestion[];
  stats: {
    total_optimizations: number;
    total_tokens_saved: number;
    total_mcp_calls: number;
    ai_suggestions_generated: number;
    ai_suggestions_applied: number;
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

const CATEGORY_TONES: Record<string, string> = {
  symbol_extraction: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  code_analysis: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  mcp_call: "bg-purple-500/10 text-purple-300 border-purple-500/30",
  ai_suggestion: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  whitespace_trim: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  stop_word_prune: "bg-teal-500/10 text-teal-300 border-teal-500/30",
  context_window_compaction: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

const SEVERITY_TONES: Record<string, string> = {
  info: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  warning: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  critical: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

// ─── main view ────────────────────────────────────────────────────────────

export function TokenOptimizerView() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"text" | "code" | "mcp" | "ai" | "history">("text");

  const { data, isLoading } = useQuery<TokenOptimizerState>({
    queryKey: ["token-optimizer"],
    queryFn: async () => {
      const res = await fetch("/api/token-optimizer");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5_000,
  });

  const resetStats = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_stats" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Zap className="h-3 w-3 text-amber-300" /> Tokens Saved
            </div>
            <div className="text-2xl font-mono text-amber-300 tabular-nums">
              {fmtNum(data.stats.total_tokens_saved)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Cpu className="h-3 w-3 text-cyan-300" /> Optimizations
            </div>
            <div className="text-2xl font-mono text-cyan-300 tabular-nums">
              {fmtNum(data.stats.total_optimizations)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Network className="h-3 w-3 text-purple-300" /> MCP Calls
            </div>
            <div className="text-2xl font-mono text-purple-300 tabular-nums">
              {fmtNum(data.stats.total_mcp_calls)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <Sparkles className="h-3 w-3 text-rose-300" /> AI Suggestions
            </div>
            <div className="text-2xl font-mono text-rose-300 tabular-nums">
              {data.stats.ai_suggestions_applied}/{data.stats.ai_suggestions_generated}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3 flex flex-col justify-between">
            <div className="text-[10px] uppercase text-muted-foreground">MCP Servers</div>
            <div className="text-2xl font-mono text-foreground tabular-nums">
              {data.mcp_servers.filter((s) => s.enabled).length}/{data.mcp_servers.length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tab selector */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {([
          ["text", "Text Optimizer", Zap],
          ["code", "Code Analyzer", Code2],
          ["mcp", "MCP Servers", Network],
          ["ai", "AI Suggestions", Sparkles],
          ["history", "History", Cpu],
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
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-[10px] font-mono"
          onClick={() => resetStats.mutate()}
          disabled={resetStats.isPending}
        >
          {resetStats.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
          Reset stats
        </Button>
      </div>

      {tab === "text" && <TextOptimizerTab />}
      {tab === "code" && <CodeAnalyzerTab />}
      {tab === "mcp" && <McpTab servers={data.mcp_servers} />}
      {tab === "ai" && <AiSuggestionsTab suggestions={data.ai_suggestions} />}
      {tab === "history" && <HistoryTab optimizations={data.optimizations} />}
    </div>
  );
}

// ─── text optimizer tab ───────────────────────────────────────────────────

function TextOptimizerTab() {
  const qc = useQueryClient();
  const [input, setInput] = useState(defaultSampleText());
  const [opts, setOpts] = useState({
    extract_symbols: true,
    prune_stop_words: false,
    trim_whitespace: true,
  });

  const optimize = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "optimize_text", input, ...opts }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const r = optimize.data;
  const tokenCount = useQuery({
    queryKey: ["token-estimate", input],
    queryFn: async () => {
      const res = await fetch(`/api/token-optimizer?estimate=${encodeURIComponent(input)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 2_000,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* INPUT */}
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-300" /> Input
            </CardTitle>
            <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
              <span>{input.length} chars</span>
              <span>·</span>
              <span>{tokenCount.data?.estimated_tokens ?? "…"} tokens</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono text-xs min-h-[280px] resize-y"
            placeholder="Paste text or code to optimize…"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs">
              <Switch
                checked={opts.extract_symbols}
                onCheckedChange={(v) => setOpts({ ...opts, extract_symbols: v })}
              />
              <span>Symbol extraction</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <Switch
                checked={opts.trim_whitespace}
                onCheckedChange={(v) => setOpts({ ...opts, trim_whitespace: v })}
              />
              <span>Trim whitespace</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <Switch
                checked={opts.prune_stop_words}
                onCheckedChange={(v) => setOpts({ ...opts, prune_stop_words: v })}
              />
              <span>Prune stop words</span>
            </label>
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => optimize.mutate()}
              disabled={optimize.isPending || !input}
            >
              {optimize.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
              Optimize
            </Button>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Tip: symbol extraction works best with long identifiers or string literals repeated 2+ times. The dictionary footer is appended so the LLM can expand aliases back.
          </div>
        </CardContent>
      </Card>

      {/* OUTPUT */}
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-rose-300" /> Optimized Output
            </CardTitle>
            {r && (
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <Badge variant="outline" className="bg-amber-500/10 text-amber-300 border-amber-500/30">
                  −{r.tokens_saved} tokens ({r.tokens_before > 0 ? Math.round((r.tokens_saved / r.tokens_before) * 100) : 0}%)
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {r ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-md border border-border/60 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase">Before</div>
                  <div className="font-mono text-foreground">{r.tokens_before}</div>
                </div>
                <div className="rounded-md border border-border/60 bg-background/40 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase">After</div>
                  <div className="font-mono text-foreground">{r.tokens_after}</div>
                </div>
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
                  <div className="text-[9px] text-muted-foreground uppercase">Saved</div>
                  <div className="font-mono text-emerald-300">−{r.tokens_saved}</div>
                </div>
              </div>
              {r.steps.length > 0 && (
                <div className="space-y-1">
                  {r.steps.map((s: string, i: number) => (
                    <div key={i} className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 className="h-2.5 w-2.5 text-emerald-300" />
                      {s}
                    </div>
                  ))}
                </div>
              )}
              <ScrollArea className="h-[280px] rounded-md border border-border/60 bg-background/40">
                <pre className="text-[10px] font-mono p-3 whitespace-pre-wrap break-words">{r.result}</pre>
              </ScrollArea>
              {r.dictionary && Object.keys(r.dictionary.aliases).length > 0 && (
                <details>
                  <summary className="text-[10px] font-mono text-muted-foreground cursor-pointer">
                    Symbol dictionary ({Object.keys(r.dictionary.aliases).length} entries)
                  </summary>
                  <ScrollArea className="h-[120px] rounded-md border border-border/60 bg-background/40 mt-1">
                    <div className="p-2 space-y-0.5">
                      {Object.entries(r.dictionary.aliases).map(([alias, orig]) => (
                        <div key={alias} className="text-[10px] font-mono flex gap-2">
                          <span className="text-cyan-300">{alias}</span>
                          <span className="text-muted-foreground">=</span>
                          <span className="text-foreground">{String(orig)}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </details>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/40" />
              <div className="text-xs text-muted-foreground">
                Run the optimizer to see the compressed output, savings, and symbol dictionary.
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function defaultSampleText() {
  return `The categorization_capability_index module is responsible for managing the categorization_capability_index state. When categorization_capability_index receives a new task, it dispatches to categorization_capability_index workers. Each categorization_capability_index worker reports back to categorization_capability_index via the categorization_capability_index API. If categorization_capability_index encounters an error, categorization_capability_index retries up to 3 times. categorization_capability_index logs every categorization_capability_index event to the audit log.`;
}

// ─── code analyzer tab ────────────────────────────────────────────────────

function CodeAnalyzerTab() {
  const qc = useQueryClient();
  const [code, setCode] = useState(defaultSampleCode());
  const [genPreview, setGenPreview] = useState(true);

  const analyze = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze_code", code, generate_preview: genPreview }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const r = analyze.data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Code2 className="h-4 w-4 text-blue-300" /> Source Code
            </CardTitle>
            <label className="flex items-center gap-1.5 text-[10px]">
              <Switch checked={genPreview} onCheckedChange={setGenPreview} />
              <span className="text-muted-foreground">Preview</span>
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono text-xs min-h-[360px] resize-y"
            placeholder="Paste code to analyze…"
          />
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">
              {code.length} chars · {code.split("\n").length} lines
            </div>
            <Button size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || !code}>
              {analyze.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
              Analyze
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-rose-300" /> Findings
            </CardTitle>
            {r && (
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <Badge variant="outline" className="bg-blue-500/10 text-blue-300 border-blue-500/30">
                  {r.findings.length} findings
                </Badge>
                <Badge variant="outline" className="bg-amber-500/10 text-amber-300 border-amber-500/30">
                  ~{r.estimated_savings} tokens saveable
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {r ? (
            <>
              <ScrollArea className="h-[300px] rounded-md border border-border/60 bg-background/40">
                <div className="p-2 space-y-1.5">
                  {r.findings.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-8">
                      No findings — the code is already clean.
                    </div>
                  ) : (
                    r.findings.map((f: any) => (
                      <div
                        key={f.id}
                        className="rounded-md border border-border/60 bg-card/40 p-2 text-xs space-y-1"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={`text-[9px] font-mono ${SEVERITY_TONES[f.severity] || SEVERITY_TONES.info}`}>
                            {f.severity}
                          </Badge>
                          <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                            {f.category}
                          </Badge>
                          {f.line_start && (
                            <span className="text-[9px] font-mono text-muted-foreground">
                              L{f.line_start}{f.line_end ? `–${f.line_end}` : ""}
                            </span>
                          )}
                          <span className="ml-auto text-[9px] font-mono text-emerald-300">
                            −{f.est_tokens_saved} tok
                          </span>
                        </div>
                        <div className="text-foreground">{f.message}</div>
                        {f.evidence && (
                          <pre className="text-[9px] font-mono text-muted-foreground bg-muted/20 rounded p-1 overflow-x-auto">
                            {f.evidence}
                          </pre>
                        )}
                        {f.suggested_fix && (
                          <div className="text-[10px] text-cyan-300/90 flex items-start gap-1">
                            <Sparkles className="h-2.5 w-2.5 mt-0.5 shrink-0" />
                            <span>{f.suggested_fix}</span>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
              {genPreview && r.optimized_preview && (
                <details>
                  <summary className="text-[10px] font-mono text-muted-foreground cursor-pointer">
                    Optimized preview (dead code stripped)
                  </summary>
                  <ScrollArea className="h-[150px] rounded-md border border-border/60 bg-background/40 mt-1">
                    <pre className="text-[10px] font-mono p-2 whitespace-pre-wrap">{r.optimized_preview}</pre>
                  </ScrollArea>
                </details>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
              <Code2 className="h-8 w-8 text-muted-foreground/40" />
              <div className="text-xs text-muted-foreground">
                AST-lite analyzer detects: duplication, redundant imports, dead code, verbose patterns, long literals, boilerplate.
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function defaultSampleCode() {
  return `import { foo } from 'bar';
import { baz } from 'bar';
import { qux } from 'bar';

// dead code below — should be removed
// line 2
// line 3
// line 4
// line 5
// line 6

function redundant(x) {
  console.log('debug_prefix start');
  console.log('debug_prefix middle');
  console.log('debug_prefix end');
  if (x === 'a' || x === 'b' || x === 'c' || x === 'd') {
    return true;
  }
  return false;
}

const longString = "this is a really long string literal that should probably be extracted to a symbol because it is way too verbose to keep inlining in the code";
`;
}

// ─── MCP tab ──────────────────────────────────────────────────────────────

function McpTab({ servers }: { servers: McpServerConfig[] }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(servers[0]?.id ?? null);
  const [callResult, setCallResult] = useState<Record<string, any>>({});

  const toggle = useMutation({
    mutationFn: async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_mcp", server_id: serverId, enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const remove = useMutation({
    mutationFn: async (serverId: string) => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_mcp", server_id: serverId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const callTool = useMutation({
    mutationFn: async ({ serverId, toolName, args }: { serverId: string; toolName: string; args: Record<string, unknown> }) => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "call_mcp", server_id: serverId, tool_name: toolName, args }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data, vars) => {
      setCallResult((prev) => ({ ...prev, [`${vars.serverId}:${vars.toolName}`]: data }));
      qc.invalidateQueries({ queryKey: ["token-optimizer"] });
    },
  });

  return (
    <div className="space-y-3">
      {/* Register new MCP */}
      <RegisterMcpCard />

      {/* Server list */}
      <div className="space-y-2">
        {servers.map((srv) => (
          <Card key={srv.id} className="bg-card/40 border-border/60">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  onClick={() => setExpanded(expanded === srv.id ? null : srv.id)}
                >
                  <Network className={`h-4 w-4 ${srv.enabled ? "text-purple-300" : "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{srv.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground truncate">
                      {srv.transport} · {srv.endpoint || srv.command || "—"} {srv.args?.length ? srv.args.join(" ") : ""}
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  {srv.enabled ? (
                    <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                      <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> enabled
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] font-mono bg-slate-500/10 text-slate-300 border-slate-500/30">
                      <XCircle className="h-2.5 w-2.5 mr-1" /> disabled
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                    {srv.tools.length} tools
                  </Badge>
                  <Badge variant="outline" className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40">
                    {srv.call_count} calls
                  </Badge>
                  <Switch
                    checked={srv.enabled}
                    onCheckedChange={(v) => toggle.mutate({ serverId: srv.id, enabled: v })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-300"
                    onClick={() => remove.mutate(srv.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            {expanded === srv.id && (
              <CardContent className="pt-0 space-y-2">
                <Separator className="bg-border/40" />
                <div className="text-[10px] uppercase text-muted-foreground">Tools</div>
                <div className="space-y-1.5">
                  {srv.tools.map((tool) => {
                    const key = `${srv.id}:${tool.name}`;
                    const result = callResult[key];
                    return (
                      <div key={tool.name} className="rounded-md border border-border/60 bg-background/40 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-mono text-foreground">{tool.name}</div>
                            <div className="text-[10px] text-muted-foreground">{tool.description}</div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px]"
                            disabled={!srv.enabled || callTool.isPending}
                            onClick={() => {
                              // Use default args derived from input_schema
                              const args: Record<string, unknown> = {};
                              const props = (tool.input_schema as any)?.properties || {};
                              for (const [k, v] of Object.entries(props)) {
                                const type = (v as any).type;
                                if (type === "string") args[k] = k === "path" ? "/home/z/my-project/src" : "test";
                                else if (type === "number") args[k] = 1;
                                else if (type === "boolean") args[k] = true;
                                else if (type === "array") args[k] = [];
                                else args[k] = null;
                              }
                              callTool.mutate({ serverId: srv.id, toolName: tool.name, args });
                            }}
                          >
                            {callTool.isPending && callTool.variables?.serverId === srv.id && callTool.variables?.toolName === tool.name ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Play className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                        {result && (
                          <pre className="mt-1.5 text-[9px] font-mono bg-muted/30 rounded p-1.5 overflow-x-auto max-h-[120px]">
                            {JSON.stringify(result, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function RegisterMcpCard() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [endpoint, setEndpoint] = useState("");
  const [command, setCommand] = useState("");

  const register = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register_mcp",
          name,
          transport,
          endpoint: endpoint || undefined,
          command: command || undefined,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setName("");
      setEndpoint("");
      setCommand("");
      qc.invalidateQueries({ queryKey: ["token-optimizer"] });
    },
  });

  return (
    <Card className="bg-card/40 border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Plus className="h-4 w-4 text-emerald-300" /> Register MCP Server
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" className="h-8 text-xs font-mono" />
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Transport</Label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as "stdio" | "http" | "sse")}
              className="w-full h-8 rounded-md border border-border/60 bg-background px-2 text-xs font-mono"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </div>
          {transport === "stdio" ? (
            <div>
              <Label className="text-[10px] uppercase text-muted-foreground">Command</Label>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @mcp/server-foo" className="h-8 text-xs font-mono" />
            </div>
          ) : (
            <div>
              <Label className="text-[10px] uppercase text-muted-foreground">Endpoint</Label>
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://mcp.example.com/sse" className="h-8 text-xs font-mono" />
            </div>
          )}
          <div className="flex items-end">
            <Button
              size="sm"
              className="w-full"
              disabled={!name || register.isPending}
              onClick={() => register.mutate()}
            >
              {register.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
              Register
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── AI suggestions tab ───────────────────────────────────────────────────

function AiSuggestionsTab({ suggestions }: { suggestions: AiSuggestion[] }) {
  const qc = useQueryClient();
  const [input, setInput] = useState("");

  const generate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate_ai_suggestions", input, max_suggestions: 5 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const apply = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply_ai_suggestion", suggestion_id: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/token-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss_ai_suggestion", suggestion_id: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["token-optimizer"] }),
  });

  return (
    <div className="space-y-3">
      <Card className="bg-card/40 border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-rose-300" /> Generate AI Suggestions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono text-xs min-h-[120px]"
            placeholder="Paste text or code you want the AI to suggest optimizations for…"
          />
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">
              Calls the default free-tier LLM (Z.ai GLM-4.6). Returns ≤5 suggestions as strict JSON.
            </div>
            <Button size="sm" disabled={!input || generate.isPending} onClick={() => generate.mutate()}>
              {generate.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              Generate
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {suggestions.length === 0 ? (
          <Card className="bg-card/40 border-border/60">
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No suggestions yet. Generate some above.
            </CardContent>
          </Card>
        ) : (
          suggestions.slice().reverse().map((s) => (
            <Card key={s.id} className={`bg-card/40 border-border/60 ${s.applied ? "opacity-60" : ""}`}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{s.title}</div>
                    <div className="text-[11px] text-muted-foreground">{s.description}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
                      −{s.est_tokens_saved} tok
                    </Badge>
                    <Badge variant="outline" className="text-[9px] font-mono bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                      {(s.confidence * 100).toFixed(0)}% conf
                    </Badge>
                    {s.applied && (
                      <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                        applied
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <div className="text-[9px] uppercase text-muted-foreground mb-1">Before</div>
                    <pre className="text-[9px] font-mono bg-muted/20 rounded p-1.5 max-h-[100px] overflow-auto whitespace-pre-wrap">{s.before_preview}</pre>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-muted-foreground mb-1">After</div>
                    <pre className="text-[9px] font-mono bg-emerald-500/5 rounded p-1.5 max-h-[100px] overflow-auto whitespace-pre-wrap">{s.after_preview}</pre>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {s.model_id} · {fmtTime(s.ts)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!s.applied && (
                      <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => apply.mutate(s.id)}>
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Apply
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[10px] text-muted-foreground hover:text-rose-300"
                      onClick={() => dismiss.mutate(s.id)}
                    >
                      <XCircle className="h-3 w-3 mr-1" /> Dismiss
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

// ─── history tab ──────────────────────────────────────────────────────────

function HistoryTab({ optimizations }: { optimizations: OptimizationRecord[] }) {
  if (optimizations.length === 0) {
    return (
      <Card className="bg-card/40 border-border/60">
        <CardContent className="py-12 text-center text-xs text-muted-foreground">
          No optimizations recorded yet. Use the Text Optimizer, Code Analyzer, MCP tools, or AI Suggestions to start saving tokens.
        </CardContent>
      </Card>
    );
  }

  const totalSaved = optimizations.filter((o) => o.applied).reduce((sum, o) => sum + o.tokens_saved, 0);

  return (
    <Card className="bg-card/40 border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="h-4 w-4 text-cyan-300" /> Recent Optimizations
          </CardTitle>
          <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
            {totalSaved} tokens saved (this view)
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[480px]">
          <div className="space-y-1.5">
            {optimizations.slice().reverse().map((o) => (
              <div key={o.id} className="rounded-md border border-border/60 bg-background/40 p-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-[9px] font-mono ${CATEGORY_TONES[o.category] || CATEGORY_TONES.code_analysis}`}>
                    {o.category}
                  </Badge>
                  {o.applied ? (
                    <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                      <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> applied
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] font-mono bg-slate-500/10 text-slate-300 border-slate-500/30">
                      observed
                    </Badge>
                  )}
                  <span className="text-[10px] font-mono text-muted-foreground">{fmtTime(o.ts)}</span>
                  <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                    {o.model_id}
                  </span>
                  {o.applied && o.tokens_saved > 0 && (
                    <Badge variant="outline" className="text-[9px] font-mono bg-amber-500/10 text-amber-300 border-amber-500/30">
                      −{o.tokens_saved} tok
                    </Badge>
                  )}
                </div>
                <div className="text-foreground mt-1">{o.description}</div>
                <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                  in: {o.input_tokens} · out: {o.output_tokens}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

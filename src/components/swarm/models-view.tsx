"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, ExternalLink, Cpu } from "lucide-react";

interface ModelEntry {
  id: string;
  display_name: string;
  provider: string;
  model_id: string;
  context_window: number;
  capabilities: string[];
  free_tier_limit: string;
  docs_url: string;
  available: boolean;
  api_key_env: string;
  endpoint: string;
}

interface ModelsResponse {
  total: number;
  available: number;
  default: { id: string; display_name: string; provider: string } | null;
  models: ModelEntry[];
}

const PROVIDER_TONES: Record<string, string> = {
  deepseek: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  openrouter: "bg-purple-500/10 text-purple-300 border-purple-500/20",
  mistral: "bg-orange-500/10 text-orange-300 border-orange-500/20",
  qwen: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
  ollama: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  zai: "bg-rose-500/10 text-rose-300 border-rose-500/20",
};

export function ModelsView() {
  const [filter, setFilter] = useState<"all" | "available" | "unavailable">("all");

  const { data, isLoading, isError, error } = useQuery<ModelsResponse>({
    queryKey: ["models"],
    queryFn: async () => {
      const res = await fetch("/api/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  if (isLoading) {
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

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <div className="h-10 w-10 rounded-full bg-rose-500/15 text-rose-300 flex items-center justify-center">
          <Cpu className="h-5 w-5" />
        </div>
        <div className="text-sm font-medium">Couldn&apos;t load model registry</div>
        <div className="text-xs text-muted-foreground max-w-md">
          {(error as Error)?.message || "Unknown error."}
        </div>
      </div>
    );
  }

  const filtered = data.models.filter((m) => {
    if (filter === "available") return m.available;
    if (filter === "unavailable") return !m.available;
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Total models</div>
            <div className="text-2xl font-mono text-foreground">{data.total}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Available</div>
            <div className="text-2xl font-mono text-emerald-300">{data.available}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Default</div>
            <div className="text-sm font-mono text-foreground truncate">
              {data.default?.display_name ?? "—"}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/40 border-border/60">
          <CardContent className="p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Providers</div>
            <div className="text-2xl font-mono text-foreground">
              {new Set(data.models.map((m) => m.provider)).size}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 text-xs">
        {(["all", "available", "unavailable"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={
              "rounded-full px-3 py-1 font-mono " +
              (filter === f
                ? "bg-primary text-primary-foreground"
                : "bg-card/60 text-muted-foreground hover:text-foreground")
            }
          >
            {f === "all"
              ? `All (${data.total})`
              : f === "available"
                ? `Available (${data.available})`
                : `Unavailable (${data.total - data.available})`}
          </button>
        ))}
      </div>

      {/* Model grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((m) => {
          const tone =
            PROVIDER_TONES[m.provider] ?? "bg-slate-500/10 text-slate-300 border-slate-500/20";
          return (
            <Card
              key={m.id}
              className={
                "bg-card/40 border-border/60 " +
                (m.available ? "" : "opacity-60")
              }
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <CardTitle className="text-sm font-medium truncate">
                      {m.display_name}
                    </CardTitle>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge
                        variant="outline"
                        className={"text-[9px] font-mono " + tone}
                      >
                        {m.provider}
                      </Badge>
                      {m.available ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                        >
                          <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                          ready
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono bg-rose-500/10 text-rose-300 border-rose-500/30"
                        >
                          <XCircle className="h-2.5 w-2.5 mr-1" />
                          no key
                        </Badge>
                      )}
                    </div>
                  </div>
                  <a
                    href={m.docs_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label={`Docs for ${m.display_name}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </CardHeader>
              <CardContent className="text-xs space-y-2">
                <div className="font-mono text-[10px] text-muted-foreground break-all">
                  {m.model_id}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>ctx: {(m.context_window / 1000).toFixed(0)}k</span>
                  <span>·</span>
                  <span className="truncate">{m.free_tier_limit}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {m.capabilities.map((c) => (
                    <Badge
                      key={c}
                      variant="outline"
                      className="text-[9px] font-mono bg-muted/30 text-muted-foreground border-border/40"
                    >
                      {c}
                    </Badge>
                  ))}
                </div>
                {!m.available && (
                  <div className="pt-1 text-[10px] text-rose-300/80 font-mono">
                    Set <code className="text-rose-200">{m.api_key_env}</code> in .env to activate
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Usage policy */}
      <Card className="bg-amber-500/5 border-amber-500/20">
        <CardContent className="p-3 text-xs text-amber-200/80">
          <span className="font-medium">Usage policy:</span>{" "}
          These models power legitimate swarm work — HIT marketplace tasks,
          content creation, data analysis, document processing, accessibility
          audits. They must not be used for coordinated inauthentic behavior,
          account creation on third-party platforms, behavioral scraping,
          influence operations, or any activity prohibited by the platform&apos;s
          ToS. Every agent&apos;s system prompt enforces these constraints.
        </CardContent>
      </Card>
    </div>
  );
}

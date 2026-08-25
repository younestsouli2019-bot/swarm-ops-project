"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Rocket, Play, Pause, CheckCircle, Clock, AlertTriangle } from "lucide-react";

export function ExecutionView() {
  const { data } = useQuery({
    queryKey: ["execution"],
    queryFn: () => fetch("/api/execution").then((r) => r.json()),
    refetchInterval: 10000,
  });

  const pipelines = data?.pipelines ?? [];
  const stats = data?.stats ?? { running: 0, completed: 0, failed: 0, queued: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Execution</h2>
        <p className="text-xs text-muted-foreground">Pipeline execution engine, run history, and stage progress</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Running", value: stats.running, icon: Play, color: "text-cyan-400" },
          { label: "Completed", value: stats.completed, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Failed", value: stats.failed, icon: AlertTriangle, color: "text-rose-400" },
          { label: "Queued", value: stats.queued, icon: Clock, color: "text-amber-400" },
        ].map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <s.icon className={`h-3 w-3 ${s.color ?? ""}`} />
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Pipeline</th>
              <th className="text-left px-4 py-2.5 font-medium">Stage</th>
              <th className="text-left px-4 py-2.5 font-medium">Progress</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(p.name ?? "—").slice(0, 16)}</td>
                <td className="px-4 py-2.5">{String(p.stage ?? "—")}</td>
                <td className="px-4 py-2.5">
                  <div className="w-full bg-border/40 rounded-full h-1.5">
                    <div className="bg-emerald-400 h-1.5 rounded-full" style={{ width: `${p.progress ?? 0}%` }} />
                  </div>
                  <span className="text-[9px] text-muted-foreground font-mono">{String(p.progress ?? 0)}%</span>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={p.status === "completed" ? "default" : p.status === "failed" ? "destructive" : "secondary"} className="text-[9px]">{String(p.status ?? "—")}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground font-mono">{String(p.duration ?? "—")}</td>
              </tr>
            ))}
            {pipelines.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No pipelines executed yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

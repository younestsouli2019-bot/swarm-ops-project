"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, TrendingUp, Brain, Sparkles } from "lucide-react";

export function LearningView() {
  const { data } = useQuery({
    queryKey: ["learning"],
    queryFn: () => fetch("/api/learning").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const metrics = data?.metrics ?? {};
  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Swarm Learning</h2>
        <p className="text-xs text-muted-foreground">Agent performance feedback, reward signals, and capability evolution</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Sessions", value: metrics.total_sessions ?? 0, icon: GraduationCap },
          { label: "Avg Reward", value: `${(metrics.avg_reward ?? 0).toFixed(2)}`, icon: TrendingUp, color: "text-emerald-400" },
          { label: "Capabilities Evolved", value: metrics.capabilities_evolved ?? 0, icon: Brain, color: "text-cyan-400" },
          { label: "Active Learners", value: metrics.active_learners ?? 0, icon: Sparkles, color: "text-amber-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Session</th>
              <th className="text-left px-4 py-2.5 font-medium">Agent</th>
              <th className="text-left px-4 py-2.5 font-medium">Task</th>
              <th className="text-left px-4 py-2.5 font-medium">Reward</th>
              <th className="text-left px-4 py-2.5 font-medium">Improvement</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.session_id ?? "—").slice(0, 12)}</td>
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.agent_id ?? "—").slice(0, 10)}</td>
                <td className="px-4 py-2.5">{String(s.task_type ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono">{String(s.reward ?? "—")}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={Number(s.improvement ?? 0) > 0 ? "default" : "secondary"} className="text-[9px]">
                    {Number(s.improvement ?? 0) > 0 ? "+" : ""}{String(s.improvement ?? "—")}%
                  </Badge>
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No learning sessions recorded</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

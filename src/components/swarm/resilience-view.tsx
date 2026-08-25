"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Shield, RefreshCw, AlertTriangle, CheckCircle, Clock } from "lucide-react";

export function ResilienceView() {
  const { data } = useQuery({
    queryKey: ["resilience"],
    queryFn: () => fetch("/api/resilience").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const systems = data?.systems ?? [];
  const stats = data?.stats ?? { total: 0, healthy: 0, degraded: 0, failed: 0 };
  const incidents = data?.incidents ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Resilience</h2>
        <p className="text-xs text-muted-foreground">Fault tolerance, auto-recovery, circuit breakers, and incident history</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Systems", value: stats.total, icon: Shield },
          { label: "Healthy", value: stats.healthy, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Degraded", value: stats.degraded, icon: AlertTriangle, color: "text-amber-400" },
          { label: "Failed", value: stats.failed, icon: Zap, color: "text-rose-400" },
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border/40 text-xs font-medium text-muted-foreground">Circuit Breakers</div>
          <table className="w-full text-xs">
            <tbody>
              {systems.map((s: Record<string, unknown>, i: number) => (
                <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                  <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.name ?? "—")}</td>
                  <td className="px-4 py-2.5 text-center">
                    <Badge variant={s.state === "closed" ? "default" : s.state === "open" ? "destructive" : "secondary"} className="text-[9px]">{String(s.state ?? "closed")}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground font-mono">{String(s.failures ?? 0)}/{String(s.threshold ?? 5)}</td>
                </tr>
              ))}
              {systems.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-4 text-center text-muted-foreground">No circuit breakers</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border/40 text-xs font-medium text-muted-foreground">Recent Incidents</div>
          <table className="w-full text-xs">
            <tbody>
              {incidents.map((inc: Record<string, unknown>, i: number) => (
                <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                  <td className="px-4 py-2.5 font-mono text-[10px]">{String(inc.timestamp ?? "—")}</td>
                  <td className="px-4 py-2.5">{String(inc.description ?? "—").slice(0, 30)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <Badge variant={inc.resolved ? "default" : "destructive"} className="text-[9px]">{inc.resolved ? "resolved" : "active"}</Badge>
                  </td>
                </tr>
              ))}
              {incidents.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-4 text-center text-muted-foreground">No incidents</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

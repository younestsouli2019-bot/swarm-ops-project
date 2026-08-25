"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Radio, RefreshCw, CheckCircle, AlertTriangle, Clock } from "lucide-react";

export function SwarmSyncView() {
  const { data } = useQuery({
    queryKey: ["swarm-sync"],
    queryFn: () => fetch("/api/swarm-sync").then((r) => r.json()),
    refetchInterval: 10000,
  });

  const nodes = data?.nodes ?? [];
  const stats = data?.stats ?? { total: 0, synced: 0, lagging: 0, offline: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Swarm Sync</h2>
        <p className="text-xs text-muted-foreground">Node synchronization, state replication, and consistency checks</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Nodes", value: stats.total, icon: Radio },
          { label: "Synced", value: stats.synced, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Lagging", value: stats.lagging, icon: RefreshCw, color: "text-amber-400" },
          { label: "Offline", value: stats.offline, icon: AlertTriangle, color: "text-rose-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Node</th>
              <th className="text-left px-4 py-2.5 font-medium">Region</th>
              <th className="text-left px-4 py-2.5 font-medium">Last Sync</th>
              <th className="text-left px-4 py-2.5 font-medium">Lag</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(n.name ?? "—").slice(0, 16)}</td>
                <td className="px-4 py-2.5">{String(n.region ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(n.last_sync ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono">{String(n.lag ?? "0")}ms</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={n.status === "synced" ? "default" : n.status === "offline" ? "destructive" : "secondary"} className="text-[9px]">{String(n.status ?? "—")}</Badge>
                </td>
              </tr>
            ))}
            {nodes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No sync nodes configured</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

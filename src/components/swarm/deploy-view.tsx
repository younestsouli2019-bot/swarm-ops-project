"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitBranch, Play, CheckCircle, AlertTriangle, Clock } from "lucide-react";

export function DeployView() {
  const { data } = useQuery({
    queryKey: ["deploy"],
    queryFn: () => fetch("/api/deploy").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const deployments = data?.deployments ?? [];
  const stats = data?.stats ?? { total: 0, success: 0, failed: 0, rolling_back: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Deploy</h2>
        <p className="text-xs text-muted-foreground">Deployment history, rollback status, and release management</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats.total, icon: GitBranch },
          { label: "Success", value: stats.success, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Failed", value: stats.failed, icon: AlertTriangle, color: "text-rose-400" },
          { label: "Rolling Back", value: stats.rolling_back, icon: Clock, color: "text-amber-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Commit</th>
              <th className="text-left px-4 py-2.5 font-medium">Branch</th>
              <th className="text-left px-4 py-2.5 font-medium">Message</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Deployed</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(d.commit ?? "—").slice(0, 8)}</td>
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(d.branch ?? "main")}</Badge></td>
                <td className="px-4 py-2.5">{String(d.message ?? "—").slice(0, 40)}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={d.status === "success" ? "default" : d.status === "failed" ? "destructive" : "secondary"} className="text-[9px]">{String(d.status ?? "—")}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{String(d.deployed_at ?? "—")}</td>
              </tr>
            ))}
            {deployments.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No deployments recorded</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, FileText, AlertTriangle, CheckCircle, Clock } from "lucide-react";

export function AuditView() {
  const { data } = useQuery({
    queryKey: ["audit"],
    queryFn: () => fetch("/api/audit").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const events = data?.events ?? [];
  const stats = data?.stats ?? { total: 0, passed: 0, warnings: 0, failures: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Audit</h2>
        <p className="text-xs text-muted-foreground">Compliance audit trail, regulatory checks, and integrity verification</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Events", value: stats.total, icon: FileText },
          { label: "Passed", value: stats.passed, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Warnings", value: stats.warnings, icon: AlertTriangle, color: "text-amber-400" },
          { label: "Failures", value: stats.failures, icon: ShieldAlert, color: "text-rose-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Timestamp</th>
              <th className="text-left px-4 py-2.5 font-medium">Category</th>
              <th className="text-left px-4 py-2.5 font-medium">Event</th>
              <th className="text-left px-4 py-2.5 font-medium">Actor</th>
              <th className="text-center px-4 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(e.timestamp ?? "—")}</td>
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(e.category ?? "—")}</Badge></td>
                <td className="px-4 py-2.5">{String(e.event ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(e.actor ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={e.result === "pass" ? "default" : e.result === "fail" ? "destructive" : "secondary"} className="text-[9px]">{String(e.result ?? "—")}</Badge>
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No audit events recorded</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditCard, CheckCircle, XCircle, Clock } from "lucide-react";

export function PaymentsView() {
  const { data } = useQuery({
    queryKey: ["payments"],
    queryFn: () => fetch("/api/payments/status").then((r) => r.json()),
    refetchInterval: 10000,
  });

  const payments = data?.payments ?? [];
  const stats = data?.stats ?? { total: 0, succeeded: 0, failed: 0, pending: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Payments</h2>
        <p className="text-xs text-muted-foreground">Payment routing, transaction history, and PSP status</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats.total, icon: CreditCard },
          { label: "Succeeded", value: stats.succeeded, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Failed", value: stats.failed, icon: XCircle, color: "text-rose-400" },
          { label: "Pending", value: stats.pending, icon: Clock, color: "text-amber-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Payment ID</th>
              <th className="text-left px-4 py-2.5 font-medium">Rail</th>
              <th className="text-left px-4 py-2.5 font-medium">Amount</th>
              <th className="text-left px-4 py-2.5 font-medium">Recipient</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(p.id ?? "—").slice(0, 12)}</td>
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(p.rail ?? "—")}</Badge></td>
                <td className="px-4 py-2.5 font-mono">{String(p.amount ?? "—")}</td>
                <td className="px-4 py-2.5">{String(p.recipient ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={p.status === "succeeded" ? "default" : p.status === "failed" ? "destructive" : "secondary"} className="text-[9px]">{String(p.status ?? "—")}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{String(p.created ?? "—")}</td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No payments yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

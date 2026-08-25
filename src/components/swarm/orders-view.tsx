"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Truck, CheckCircle, Clock, AlertTriangle } from "lucide-react";

export function OrdersView() {
  const { data } = useQuery({
    queryKey: ["orders"],
    queryFn: () => fetch("/api/orders").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const orders = data?.orders ?? [];
  const stats = data?.stats ?? { total: 0, pending: 0, fulfilled: 0, cancelled: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Orders</h2>
        <p className="text-xs text-muted-foreground">Purchase orders, fulfillment status, and supplier tracking</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats.total, icon: Package },
          { label: "Pending", value: stats.pending, icon: Clock, color: "text-amber-400" },
          { label: "Fulfilled", value: stats.fulfilled, icon: CheckCircle, color: "text-emerald-400" },
          { label: "Cancelled", value: stats.cancelled, icon: AlertTriangle, color: "text-rose-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Order ID</th>
              <th className="text-left px-4 py-2.5 font-medium">Supplier</th>
              <th className="text-left px-4 py-2.5 font-medium">Items</th>
              <th className="text-left px-4 py-2.5 font-medium">Amount</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(o.id ?? "—").slice(0, 12)}</td>
                <td className="px-4 py-2.5">{String(o.supplier ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono">{String(o.item_count ?? "—")}</td>
                <td className="px-4 py-2.5 font-mono">{String(o.amount ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={o.status === "fulfilled" ? "default" : o.status === "cancelled" ? "destructive" : "secondary"} className="text-[9px]">{String(o.status ?? "pending")}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{String(o.created ?? "—")}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No orders yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

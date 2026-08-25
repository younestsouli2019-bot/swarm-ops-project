"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Truck, MapPin, Package, Clock, CheckCircle } from "lucide-react";

export function ShipmentsView() {
  const { data } = useQuery({
    queryKey: ["shipments"],
    queryFn: () => fetch("/api/shipments").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const shipments = data?.shipments ?? [];
  const stats = data?.stats ?? { total: 0, in_transit: 0, delivered: 0, pending: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Shipments</h2>
        <p className="text-xs text-muted-foreground">Carrier tracking, delivery verification, and SLA compliance</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats.total, icon: Package },
          { label: "In Transit", value: stats.in_transit, icon: Truck, color: "text-cyan-400" },
          { label: "Delivered", value: stats.delivered, icon: CheckCircle, color: "text-emerald-400" },
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
              <th className="text-left px-4 py-2.5 font-medium">Tracking #</th>
              <th className="text-left px-4 py-2.5 font-medium">Carrier</th>
              <th className="text-left px-4 py-2.5 font-medium">Origin</th>
              <th className="text-left px-4 py-2.5 font-medium">Destination</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">ETA</th>
            </tr>
          </thead>
          <tbody>
            {shipments.map((s: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.tracking ?? "—").slice(0, 16)}</td>
                <td className="px-4 py-2.5">{String(s.carrier ?? "—")}</td>
                <td className="px-4 py-2.5">{String(s.origin ?? "—")}</td>
                <td className="px-4 py-2.5">{String(s.destination ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={s.status === "delivered" ? "default" : s.status === "in_transit" ? "secondary" : "outline"} className="text-[9px]">{String(s.status ?? "pending")}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{String(s.eta ?? "—")}</td>
              </tr>
            ))}
            {shipments.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No shipments yet — data enters through real carrier integrations</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

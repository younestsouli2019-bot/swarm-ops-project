"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Landmark, Link2, CheckCircle, AlertTriangle } from "lucide-react";

export function ConnectorsView() {
  const { data } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => fetch("/api/connectors").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const connectors = data?.connectors ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Connectors</h2>
        <p className="text-xs text-muted-foreground">Banking and payment integrations (SEPA, SWIFT, CMI, ChariBaaS)</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {connectors.map((c: Record<string, unknown>, i: number) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium flex items-center gap-2">
                {c.status === "active" ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                {String(c.name ?? "Connector")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Type</span>
                <Badge variant="outline" className="text-[9px]">{String(c.type ?? "—")}</Badge>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={c.status === "active" ? "default" : "secondary"} className="text-[9px]">{String(c.status ?? "inactive")}</Badge>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Success Rate</span>
                <span className="font-mono">{String(c.success_rate ?? "—")}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Response</span>
                <span className="font-mono">{String(c.response_time ?? "—")}</span>
              </div>
              {c.last_sync && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Last Sync</span>
                  <span className="font-mono">{String(c.last_sync)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {connectors.length === 0 && (
          <div className="col-span-2 text-center py-8 text-muted-foreground text-xs">No connectors configured</div>
        )}
      </div>
    </div>
  );
}

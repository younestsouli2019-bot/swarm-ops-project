"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Settings, Key, Shield, Database, Server } from "lucide-react";

export function VaultView() {
  const { data } = useQuery({
    queryKey: ["vault"],
    queryFn: () => fetch("/api/vault").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const secrets = data?.secrets ?? [];
  const config = data?.config ?? {};

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Vault</h2>
        <p className="text-xs text-muted-foreground">Secure configuration, API keys, and secrets management</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Secrets", value: secrets.length, icon: Key },
          { label: "Config Items", value: Object.keys(config).length, icon: Settings },
          { label: "Encryption", value: "AES-256", icon: Shield, color: "text-emerald-400" },
          { label: "Last Rotation", value: data?.last_rotation ?? "—", icon: Database },
        ].map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <s.icon className={`h-3 w-3 ${s.color ?? ""}`} />
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-bold font-mono">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Secret Name</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Last Used</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.name ?? "—")}</td>
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(s.type ?? "api_key")}</Badge></td>
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(s.last_used ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={s.status === "active" ? "default" : "secondary"} className="text-[9px]">{String(s.status ?? "active")}</Badge>
                </td>
              </tr>
            ))}
            {secrets.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No secrets stored</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

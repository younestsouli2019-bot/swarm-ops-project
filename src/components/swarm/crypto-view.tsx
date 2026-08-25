"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Coins, TrendingUp, Wallet, ArrowUpDown } from "lucide-react";

export function CryptoView() {
  const { data } = useQuery({
    queryKey: ["crypto"],
    queryFn: () => fetch("/api/crypto").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const wallets = data?.wallets ?? [];
  const stats = data?.stats ?? { total_value: 0, transactions: 0, chains: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Crypto</h2>
        <p className="text-xs text-muted-foreground">On-chain wallets, USDT settlements, and DeFi position tracking</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Wallet className="h-3 w-3" /> Total Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">${stats.total_value.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <ArrowUpDown className="h-3 w-3" /> Transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{stats.transactions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Coins className="h-3 w-3" /> Chains
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{stats.chains}</div>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Chain</th>
              <th className="text-left px-4 py-2.5 font-medium">Address</th>
              <th className="text-left px-4 py-2.5 font-medium">Token</th>
              <th className="text-right px-4 py-2.5 font-medium">Balance</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(w.chain ?? "—")}</Badge></td>
                <td className="px-4 py-2.5 font-mono text-[10px]">{String(w.address ?? "—").slice(0, 16)}...</td>
                <td className="px-4 py-2.5">{String(w.token ?? "—")}</td>
                <td className="px-4 py-2.5 text-right font-mono">{String(w.balance ?? "—")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={w.status === "active" ? "default" : "secondary"} className="text-[9px]">{String(w.status ?? "inactive")}</Badge>
                </td>
              </tr>
            ))}
            {wallets.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No crypto wallets configured</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

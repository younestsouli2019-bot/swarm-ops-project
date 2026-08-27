"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Coins, TrendingUp, Wallet, ArrowUpDown, ExternalLink, Zap } from "lucide-react";

export function CryptoView() {
  const { data, isLoading } = useQuery({
    queryKey: ["crypto"],
    queryFn: () => fetch("/api/crypto").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const wallets = data?.wallets ?? [];
  const stats = data?.stats ?? { total_value: 0, transactions: 0, chains: 0 };
  const railStatus = data?.rail_status;

  const explorerUrl = (chain: string, addr: string) => {
    if (chain === "BTC") return `https://blockchain.info/address/${addr}`;
    if (chain === "TRON") return `https://tronscan.org/#/address/${addr}`;
    return `https://etherscan.io/address/${addr}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Crypto Wallets</h2>
          <p className="text-xs text-muted-foreground">On-chain balances, USDT settlements, and payout execution</p>
        </div>
        {railStatus && (
          <Badge variant={railStatus.onchain_adapter === "registered" ? "default" : "secondary"} className="text-[9px]">
            <Zap className="h-2.5 w-2.5 mr-1" />
            {railStatus.onchain_adapter === "registered" ? "On-Chain Rail Active" : "Rail Offline"}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Wallet className="h-3 w-3" /> Total Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">${stats.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <ArrowUpDown className="h-3 w-3" /> Funded Wallets
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" /> Supported
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {(railStatus?.supported_tokens ?? ["BTC", "ETH", "USDT"]).map((t: string) => (
                <Badge key={t} variant="outline" className="text-[9px]">{t}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {isLoading && (
        <div className="text-xs text-muted-foreground text-center py-4">Fetching on-chain balances...</div>
      )}

      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Chain</th>
              <th className="text-left px-4 py-2.5 font-medium">Address</th>
              <th className="text-left px-4 py-2.5 font-medium">Token</th>
              <th className="text-right px-4 py-2.5 font-medium">Balance</th>
              <th className="text-right px-4 py-2.5 font-medium">USD Value</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
              <th className="text-center px-4 py-2.5 font-medium">Explorer</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5">
                  <Badge variant="outline" className="text-[9px]">{String(w.chain ?? "—")}</Badge>
                  {w.label && <div className="text-[9px] text-muted-foreground mt-0.5">{String(w.label)}</div>}
                </td>
                <td className="px-4 py-2.5 font-mono text-[10px]">
                  {String(w.address ?? "—").slice(0, 10)}...{String(w.address ?? "").slice(-6)}
                </td>
                <td className="px-4 py-2.5">{String(w.token ?? "—")}</td>
                <td className="px-4 py-2.5 text-right font-mono">{String(w.balance ?? "0")}</td>
                <td className="px-4 py-2.5 text-right font-mono">${typeof w.balance_usd === "number" ? w.balance_usd.toFixed(2) : "0.00"}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={w.status === "active" ? "default" : w.status === "error" ? "destructive" : "secondary"} className="text-[9px]">
                    {String(w.status ?? "inactive")}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-center">
                  {w.address && (
                    <a
                      href={explorerUrl(String(w.chain), String(w.address))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300"
                    >
                      <ExternalLink className="h-3 w-3 inline" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {wallets.length === 0 && !isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                No wallet balances found. Set TATUM_API_KEY or add wallet addresses to Base44 PayoutRecipients.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Card className="bg-card/20">
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Crypto Rail Status:</strong> {railStatus?.onchain_adapter === "registered" ? "Active — on-chain transfers enabled via Tatum SDK" : "Offline"}</p>
            <p><strong>Supported Chains:</strong> {railStatus?.supported_chains?.join(", ") ?? "BTC, ETH, TRON"}</p>
            <p><strong>Tatum API:</strong> {railStatus?.tatum_key ? "Connected" : "Using public blockchain APIs (set TATUM_API_KEY for higher rate limits)"}</p>
            <p><strong>Payout Endpoint:</strong> POST /api/payouts/crypto</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

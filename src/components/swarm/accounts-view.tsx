"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, CreditCard, Building2, Globe } from "lucide-react";

export function AccountsView() {
  const { data } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => fetch("/api/accounts").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const accounts = data?.accounts ?? [];
  const totals = data?.totals ?? {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Accounts</h2>
          <p className="text-xs text-muted-foreground">Owner bank accounts, PSP wallets, and balance overview</p>
        </div>
        <Badge variant="outline" className="text-[10px] font-mono">{accounts.length} accounts</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {["GBP", "MAD", "EUR", "USD"].map((ccy) => (
          <Card key={ccy}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">{ccy} Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {ccy === "GBP" ? `£${(totals.gbp ?? 0).toLocaleString()}` : ccy === "MAD" ? `MAD ${(totals.mad ?? 0).toLocaleString()}` : ccy === "EUR" ? `€${(totals.eur ?? 0).toLocaleString()}` : `$${(totals.usd ?? 0).toLocaleString()}`}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Account</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Currency</th>
              <th className="text-left px-4 py-2.5 font-medium">Institution</th>
              <th className="text-right px-4 py-2.5 font-medium">Balance</th>
              <th className="text-center px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a: Record<string, unknown>, i: number) => (
              <tr key={i} className="border-b border-border/20 hover:bg-background/30">
                <td className="px-4 py-2.5 font-mono">{String(a.identifier ?? "—").slice(0, 20)}...</td>
                <td className="px-4 py-2.5">{String(a.type ?? "bank_account")}</td>
                <td className="px-4 py-2.5"><Badge variant="outline" className="text-[9px]">{String(a.currency ?? "MAD")}</Badge></td>
                <td className="px-4 py-2.5">{String(a.bank_name ?? "—")}</td>
                <td className="px-4 py-2.5 text-right font-mono">{String(a.balance ?? "0")}</td>
                <td className="px-4 py-2.5 text-center">
                  <Badge variant={a.status === "active" ? "default" : "secondary"} className="text-[9px]">{String(a.status ?? "active")}</Badge>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No accounts configured</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

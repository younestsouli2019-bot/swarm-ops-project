/**
 * GET /api/balance/multi
 *
 * Multi-provider balance checker — queries Wise, Dwolla, Currencycloud
 * and Banking Circle for account balances across all connected providers.
 */

import { NextResponse } from "next/server";
import { WISE_CONFIGURED, getBalances as wiseBalances } from "@/lib/wise-api";
import { DWOLLA_CONFIGURED } from "@/lib/rails/dwolla";
import { CURRENCYCLOUD_CONFIGURED } from "@/lib/rails/currencycloud";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface BalanceEntry {
  provider: string;
  currency: string;
  amount: number;
  status: string;
}

export async function GET() {
  const balances: BalanceEntry[] = [];
  const errors: string[] = [];
  const providers: Record<string, boolean> = {
    wise: WISE_CONFIGURED,
    dwolla: DWOLLA_CONFIGURED,
    currencycloud: CURRENCYCLOUD_CONFIGURED,
  };

  // Wise balances
  if (WISE_CONFIGURED) {
    try {
      const wise = await wiseBalances();
      for (const b of wise) {
        balances.push({
          provider: "wise",
          currency: b.currency,
          amount: b.amount,
          status: b.status || "available",
        });
      }
    } catch (err) {
      errors.push(`Wise: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dwolla balance
  if (DWOLLA_CONFIGURED && process.env.DWOLLA_MASTER_FUNDING_SOURCE) {
    try {
      const { getBalance } = await import("@/lib/rails/dwolla");
      const bal = await getBalance();
      balances.push({
        provider: "dwolla",
        currency: bal.currency,
        amount: parseFloat(bal.value),
        status: "available",
      });
    } catch (err) {
      errors.push(`Dwolla: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Currencycloud balances
  if (CURRENCYCLOUD_CONFIGURED) {
    try {
      const { getBalance: ccBalance } = await import("@/lib/rails/currencycloud");
      for (const cur of ["USD", "EUR", "GBP", "MAD"]) {
        try {
          const bal = await ccBalance(cur);
          if (parseFloat(bal.amount) > 0) {
            balances.push({
              provider: "currencycloud",
              currency: bal.currency,
              amount: parseFloat(bal.amount),
              status: "available",
            });
          }
        } catch {
          // Skip currencies with no balance
        }
      }
    } catch (err) {
      errors.push(`Currencycloud: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    ok: true,
    providers,
    balances,
    errors,
    total_usd_equivalent: balances
      .filter((b) => b.currency === "USD")
      .reduce((sum, b) => sum + b.amount, 0),
    timestamp: new Date().toISOString(),
  });
}

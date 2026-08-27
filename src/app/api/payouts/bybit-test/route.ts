/**
 * GET /api/payouts/bybit-test
 * Tests Bybit API connectivity from Vercel's network.
 */
import { NextResponse } from "next/server";
import { bybitConfigured, getAllBybitBalances, getBybitBalance } from "@/lib/rails/bybit";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.BYBIT_API_KEY || "";
  const secret = process.env.BYBIT_API_SECRET || "";
  const live = process.env.LIVE_BYBIT === "1";

  const result: Record<string, unknown> = {
    configured: bybitConfigured(),
    key_prefix: key.substring(0, 5) + "..." + key.substring(key.length - 4),
    key_length: key.length,
    secret_length: secret.length,
    live_mode: live,
    base_url: live ? "https://api.bybit.com" : "https://api-testnet.bybit.com",
  };

  if (!bybitConfigured()) {
    result.error = "BYBIT_API_KEY or BYBIT_API_SECRET not set";
    return NextResponse.json(result);
  }

  try {
    // Test 1: Wallet balance
    const balances = await getAllBybitBalances();
    result.balances = balances;
    result.balance_count = balances.length;

    // Test 2: Try BTC balance specifically
    const btc = await getBybitBalance("BTC");
    result.btc_balance = btc;

    // Test 3: Also try from Vercel directly with raw fetch
    const crypto = require("crypto");
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const params: Record<string, string> = { accountType: "UNIFIED", recv_window: recvWindow, timestamp };
    const sortedKeys = Object.keys(params).sort();
    const qs = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");
    const paramStr = timestamp + key + recvWindow + qs;
    const sig = crypto.createHmac("sha256", secret).update(paramStr).digest("hex");
    const url = `${result.base_url}/v5/account/wallet-balance?${qs}`;

    const res = await fetch(url, {
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-SIGN": sig,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "User-Agent": "bybit-skill/1.6.0",
        "X-Referer": "bybit-skill",
      },
    });

    result.raw_status = res.status;
    const body = await res.text();
    result.raw_body = body.substring(0, 500);
    result.raw_body_length = body.length;

    if (body.length > 0) {
      try {
        const data = JSON.parse(body);
        result.retCode = data.retCode;
        result.retMsg = data.retMsg;
        if (data.retCode === 0) {
          const coins = data.result?.list?.[0]?.coin || [];
          const funded = coins.filter((c: { equity?: string }) => parseFloat(c.equity || "0") > 0);
          result.funded_coins = funded.map((c: { coin: string; equity: string; walletBalance: string }) => ({
            coin: c.coin,
            equity: c.equity,
            wallet: c.walletBalance,
          }));
          result.total_equity = data.result?.list?.[0]?.totalEquity;
        }
      } catch {
        // Not JSON
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(result);
}

/**
 * Bybit Rail Adapter — Crypto withdrawals via Bybit V5 API
 *
 * Uses Bybit V5 API to withdraw BTC/ETH/USDT from the operator's
 * Bybit account to any external wallet address.
 *
 * Requires:
 *   BYBIT_API_KEY    - Bybit API key (with withdrawal + trade permissions)
 *   BYBIT_API_SECRET - Bybit API secret
 *   LIVE_BYBIT=1     - Set to use production (default: testnet)
 *
 * Bybit V5 signing: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString)
 */

import { registerRailAdapter } from "@/lib/payout-state-machine";

const BYBIT_RAIL_ID = "bybit_withdraw";

// ─── Config ─────────────────────────────────────────────────────────

function bybitConfigured(): boolean {
  return !!(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
}

function bybitBaseUrl(): string {
  return process.env.LIVE_BYBIT === "1"
    ? "https://api.bybit.com"
    : "https://api-testnet.bybit.com";
}

// ─── HMAC signing (Bybit V5 V2 format) ─────────────────────────────

function hmacSign(secret: string, payload: string): string {
  // Node.js crypto — runs in Node runtime (not Edge)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto");
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// ─── Generic Bybit GET request ──────────────────────────────────────

async function bybitGet(
  path: string,
  params: Record<string, string> = {},
): Promise<{ retCode: number; retMsg: string; result: unknown }> {
  const secret = process.env.BYBIT_API_SECRET!;
  const apiKey = process.env.BYBIT_API_KEY!;
  const baseUrl = bybitBaseUrl();
  const timestamp = Date.now().toString();
  const recvWindow = "5000";

  const allParams: Record<string, string> = {
    timestamp,
    recv_window: recvWindow,
    ...params,
  };

  const sortedKeys = Object.keys(allParams).sort();
  const queryString = sortedKeys.map((k) => `${k}=${allParams[k]}`).join("&");
  const signature = hmacSign(secret, timestamp + apiKey + recvWindow + queryString);

  const res = await fetch(`${baseUrl}${path}?${queryString}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });

  return res.json();
}

// ─── Generic Bybit POST request ─────────────────────────────────────

async function bybitPost(
  path: string,
  body: Record<string, string> = {},
): Promise<{ retCode: number; retMsg: string; result: unknown }> {
  const secret = process.env.BYBIT_API_SECRET!;
  const apiKey = process.env.BYBIT_API_KEY!;
  const baseUrl = bybitBaseUrl();
  const timestamp = Date.now().toString();
  const recvWindow = "10000";

  const allParams: Record<string, string> = {
    timestamp,
    recv_window: recvWindow,
    ...body,
  };

  const sortedKeys = Object.keys(allParams).sort();
  const queryString = sortedKeys.map((k) => `${k}=${allParams[k]}`).join("&");
  const signature = hmacSign(secret, timestamp + apiKey + recvWindow + queryString);

  const res = await fetch(`${baseUrl}${path}?${queryString}`, {
    method: "POST",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  return res.json();
}

// ─── Wallet Balance ─────────────────────────────────────────────────

export async function getBybitBalance(coin: string): Promise<{
  total: string;
  available: string;
  locked: string;
}> {
  if (!bybitConfigured()) return { total: "0", available: "0", locked: "0" };

  try {
    const data = await bybitGet("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin,
    });

    if (data.retCode !== 0) return { total: "0", available: "0", locked: "0" };

    const coinList = (data.result as { list?: Array<{ coin?: Array<{
      coin?: string;
      equity?: string;
      walletBalance?: string;
      locked?: string;
      availableToWithdraw?: string;
    }> }> })?.list?.[0]?.coin;

    const coinBalance = coinList?.find((c) => c.coin === coin);

    return {
      total: coinBalance?.equity ?? "0",
      available: coinBalance?.availableToWithdraw ?? coinBalance?.walletBalance ?? "0",
      locked: coinBalance?.locked ?? "0",
    };
  } catch {
    return { total: "0", available: "0", locked: "0" };
  }
}

/**
 * Get all Bybit wallet balances (non-zero coins)
 */
export async function getAllBybitBalances(): Promise<
  Array<{ coin: string; chain: string; total: string; available: string }>
> {
  if (!bybitConfigured()) return [];

  try {
    const data = await bybitGet("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });

    if (data.retCode !== 0) {
      console.error("[Bybit] Balance query failed:", data.retCode, data.retMsg);
      return [];
    }

    const coins = (data.result as { list?: Array<{ coin?: Array<{
      coin: string;
      equity: string;
      walletBalance: string;
      availableToWithdraw: string;
    }> }> })?.list?.[0]?.coin ?? [];

    return coins
      .filter((c) => parseFloat(c.equity ?? "0") > 0)
      .map((c) => ({
        coin: c.coin,
        chain: c.coin,
        total: c.equity,
        available: c.availableToWithdraw ?? c.walletBalance ?? "0",
      }));
  } catch (err) {
    console.error("[Bybit] getAllBybitBalances error:", err);
    return [];
  }
}

// ─── Withdrawal ─────────────────────────────────────────────────────

export async function createBybitWithdrawal(params: {
  coin: string;
  chain: string;
  amount: string;
  toAddress: string;
  tag?: string;
}): Promise<{
  ok: boolean;
  withdrawal_id?: string;
  tx_hash?: string;
  error?: string;
}> {
  if (!bybitConfigured()) {
    return { ok: false, error: "BYBIT_API_KEY / BYBIT_API_SECRET not set" };
  }

  try {
    const body: Record<string, string> = {
      coin: params.coin,
      chain: params.chain,
      amount: params.amount,
      toAddress: params.toAddress,
    };
    if (params.tag) body.tag = params.tag;

    const data = await bybitPost("/v5/asset/withdraw/create", body);

    if (data.retCode !== 0) {
      return { ok: false, error: `Bybit ${data.retCode}: ${data.retMsg}` };
    }

    const result = data.result as { id?: string; txID?: string };
    return {
      ok: true,
      withdrawal_id: result.id ?? `bybit-${Date.now().toString(36)}`,
      tx_hash: result.txID,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Query withdrawal record
 */
export async function queryBybitWithdrawal(
  withdrawalId: string,
): Promise<{
  status: string;
  tx_hash?: string;
  amount?: string;
  coin?: string;
  error?: string;
}> {
  if (!bybitConfigured()) {
    return { status: "unknown", error: "BYBIT_API_KEY not set" };
  }

  try {
    const data = await bybitGet("/v5/asset/withdraw/query", {
      withdrawID: withdrawalId,
    });

    if (data.retCode !== 0) {
      return { status: "unknown", error: data.retMsg as string };
    }

    const list = (data.result as { list?: Array<{
      status?: string;
      txID?: string;
      amount?: string;
      coin?: string;
    }> })?.list;
    const withdrawal = list?.[0];

    return {
      status: withdrawal?.status ?? "unknown",
      tx_hash: withdrawal?.txID,
      amount: withdrawal?.amount,
      coin: withdrawal?.coin,
    };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Rail Adapter Registration ──────────────────────────────────────

function ensureBybitRail() {
  if (!bybitConfigured()) return;

  try {
    registerRailAdapter({
      id: BYBIT_RAIL_ID,
      rail: "bybit_withdraw",
      supported_recipient_types: ["crypto_wallet", "bank_account"],
      supported_currencies: ["BTC", "ETH", "USDT", "USDT-TRC20", "USDT-ERC20"],
      submit: async (args) => {
        const amount = (args.amount_cents / 100).toFixed(8);

        let coin = args.currency;
        let chain = args.currency;

        if (args.currency === "USDT-TRC20") {
          coin = "USDT";
          chain = "TRC20";
        } else if (args.currency === "USDT-ERC20") {
          coin = "USDT";
          chain = "ETH";
        } else if (args.currency === "USDT") {
          coin = "USDT";
          chain = "TRC20";
        } else if (args.currency === "BTC") {
          chain = "BTC";
        } else if (args.currency === "ETH") {
          chain = "ETH";
        }

        const result = await createBybitWithdrawal({
          coin,
          chain,
          amount,
          toAddress: args.recipient_id,
        });

        if (!result.ok) {
          return {
            ok: false,
            reason: result.error || "Bybit withdrawal failed",
            code: "rail_unreachable",
          };
        }

        return {
          ok: true,
          external_reference: result.withdrawal_id ?? `bybit-${Date.now().toString(36)}`,
          submitted_at: new Date().toISOString(),
          raw: {
            rail: "bybit_withdraw",
            withdrawal_id: result.withdrawal_id,
            tx_hash: result.tx_hash,
            coin,
            chain,
            amount,
            to_address: args.recipient_id,
            bybit_testnet: process.env.LIVE_BYBIT !== "1",
          },
        };
      },
    });
  } catch {
    // Already registered
  }
}

// Auto-register on import
ensureBybitRail();

export {
  ensureBybitRail,
  BYBIT_RAIL_ID,
  bybitConfigured,
  getBybitBalance,
  getAllBybitBalances,
  createBybitWithdrawal,
  queryBybitWithdrawal,
};

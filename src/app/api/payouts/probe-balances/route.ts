/**
 * POST /api/payouts/probe-balances
 *
 * Reads the REAL runtime credentials and queries every configured rail for
 * actual available balance. Answer to: "which platform holds the physical cash?"
 */

import { NextResponse } from "next/server";
import type { BazaarlinkBalance } from "@/lib/rails/bazaarlink";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProbeResult {
  wise: { configured: boolean; profile: string | null; balances?: Array<{ currency: string; amount: number }>; error?: string };
  bybit: { configured: boolean; live: boolean; usdt?: unknown; usdc?: unknown; error?: string };
  payoneer: { configured: boolean; account: string | null; program: string | null; balance?: unknown; error?: string };
  banking_circle: { configured: boolean; account: string | null; env: string | null; balance?: unknown; error?: string };
  crypto: { tron?: unknown; eth?: unknown; tron_error?: string; eth_error?: string };
  bazaarlink: { configured: boolean; balance?: BazaarlinkBalance; error?: string };
}

export async function GET() {
  const out: ProbeResult = {
    wise: { configured: false, profile: null },
    bybit: { configured: false, live: false },
    payoneer: { configured: false, account: null, program: null },
    banking_circle: { configured: false, account: null, env: null },
    crypto: {},
    bazaarlink: { configured: false },
  };

  // ── 1. Wise ──
  const wiseToken = process.env.WISE_API_TOKEN || "";
  const wiseProfile = process.env.WISE_PROFILE_ID || "";
  out.wise = { configured: !!wiseToken && !!wiseProfile, profile: wiseProfile || null };
  if (wiseToken && wiseProfile) {
    try {
      const r = await fetch(`https://api.wise.com/v4/profiles/${wiseProfile}/balances?types=STANDARD`, {
        headers: { Authorization: `Bearer ${wiseToken}` },
      });
      if (r.ok) {
        const d = await r.json() as Array<{ currency: string; amount: { value: number } }>;
        out.wise.balances = d.map((b) => ({ currency: b.currency, amount: b.amount.value }));
      } else {
        out.wise.error = `HTTP ${r.status}`;
      }
    } catch (e) {
      out.wise.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 2. Bybit ──
  const bybitKey = process.env.BYBIT_API_KEY || "";
  const bybitLive = process.env.LIVE_BYBIT === "1";
  out.bybit = { configured: !!bybitKey, live: bybitLive };
  if (bybitKey) {
    try {
      const { getBybitBalance } = await import("@/lib/rails/bybit");
      out.bybit.usdt = await getBybitBalance("USDT");
      out.bybit.usdc = await getBybitBalance("USDC");
    } catch (e) {
      out.bybit.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 3. Payoneer ──
  const poUserId = process.env.PAYONEER_USER_ID || "";
  out.payoneer = { configured: !!poUserId, account: process.env.PAYONEER_ACCOUNT_ID || process.env.OWNER_PAYONEER_ID || null, program: process.env.PAYONEER_PROGRAM_ID || null };
  if (poUserId) {
    try {
      const { getPayoneerBalance } = await import("@/lib/payoneer");
      out.payoneer.balance = await getPayoneerBalance();
    } catch (e) {
      out.payoneer.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 4. Banking Circle ──
  const bcAccount = process.env.BANKING_CIRCLE_ACCOUNT_ID || "";
  out.banking_circle = { configured: !!bcAccount, account: bcAccount || null, env: process.env.BANKING_CIRCLE_ENV || null };
  if (bcAccount) {
    try {
      const { getAccountBalance } = await import("@/lib/banking-circle");
      out.banking_circle.balance = await getAccountBalance();
    } catch (e) {
      out.banking_circle.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 5. Crypto owner wallets (public explorers) ──
  const { fetchWalletBalance } = await import("@/lib/rails/crypto-onchain");
  const tronWallet = "TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y";
  const ethWallet = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  try {
    out.crypto.tron = await fetchWalletBalance("tron-mainnet", tronWallet);
  } catch (e) {
    out.crypto.tron_error = e instanceof Error ? e.message : String(e);
  }
  try {
    out.crypto.eth = await fetchWalletBalance("ethereum-mainnet", ethWallet);
  } catch (e) {
    out.crypto.eth_error = e instanceof Error ? e.message : String(e);
  }

  // ── 6. Bazaarlink ──
  try {
    const { fetchBalance } = await import("@/lib/rails/bazaarlink");
    out.bazaarlink = {
      configured: !!process.env.BAZAARLINK_API_KEY,
      balance: await fetchBalance(),
    };
  } catch (e) {
    out.bazaarlink = { configured: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(out, { status: 200 });
}
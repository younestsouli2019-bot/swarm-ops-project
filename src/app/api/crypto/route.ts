import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";
import { fetchWalletBalance, type WalletBalance } from "@/lib/rails/crypto-onchain";
import { bybitConfigured, getAllBybitBalances } from "@/lib/rails/bybit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Known owner crypto wallet addresses (registered in Base44 as PayoutRecipient)
const OWNER_WALLETS = [
  {
    chain: "ETH",
    address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    label: "Trust Wallet (ETH/USDT-ERC20)",
  },
  {
    chain: "TRON",
    address: "TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y",
    label: "Trust Wallet (USDT-TRC20)",
  },
  {
    chain: "BTC",
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    label: "Bybit (BTC)",
  },
];

export async function GET() {
  try {
    // Also pull crypto_wallet recipients from Base44
    let dbWallets: Array<{ name?: string; account_identifier?: string; currency?: string }> = [];
    try {
      const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as Array<{
        name?: string;
        account_identifier?: string;
        currency?: string;
        recipient_type?: string;
      }>;
      dbWallets = recipients.filter((r) => r.recipient_type === "crypto_wallet");
    } catch {
      // Base44 unavailable — use hardcoded list
    }

    // Merge: hardcoded + Base44 crypto wallets (dedupe by address)
    const seenAddresses = new Set<string>();
    const walletDefs: Array<{ chain: string; address: string; label: string }> = [];

    for (const w of OWNER_WALLETS) {
      if (!seenAddresses.has(w.address.toLowerCase())) {
        seenAddresses.add(w.address.toLowerCase());
        walletDefs.push(w);
      }
    }

    for (const w of dbWallets) {
      const addr = w.account_identifier || "";
      if (addr && !seenAddresses.has(addr.toLowerCase())) {
        seenAddresses.add(addr.toLowerCase());
        const chain = addr.startsWith("0x") ? "ETH"
          : addr.startsWith("T") ? "TRON"
          : "BTC";
        walletDefs.push({ chain, address: addr, label: w.name || "Owner Wallet" });
      }
    }

    // Fetch on-chain balances in parallel
    const balanceResults = await Promise.allSettled(
      walletDefs.map(async (w) => {
        const chainKey = w.chain === "TRON" ? "tron-mainnet"
          : w.chain === "BTC" ? "bitcoin-mainnet"
          : "ethereum-mainnet";
        const balances = await fetchWalletBalance(chainKey, w.address);
        return balances.map((b) => ({
          ...b,
          label: w.label,
          address_short: `${w.address.slice(0, 6)}...${w.address.slice(-4)}`,
        }));
      }),
    );

    // Also fetch Bybit exchange balances
    let bybitBalances: Array<{ coin: string; chain: string; total: string; available: string }> = [];
    if (bybitConfigured()) {
      try {
        bybitBalances = await getAllBybitBalances();
      } catch {
        // Bybit unavailable
      }
    }

    const allWallets: Array<Record<string, unknown>> = [];
    let totalValueUsd = 0;
    const chains = new Set<string>();
    let txCount = 0;

    for (const result of balanceResults) {
      if (result.status === "fulfilled") {
        for (const w of result.value) {
          allWallets.push({
            chain: w.chain,
            address: w.address,
            address_short: (w as Record<string, unknown>).address_short,
            token: w.token,
            balance: w.balance,
            balance_usd: w.balance_usd,
            status: w.status,
            label: (w as Record<string, unknown>).label,
          });
          totalValueUsd += w.balance_usd;
          chains.add(w.chain);
          if (parseFloat(w.balance) > 0) txCount++;
        }
      }
    }

    // Add Bybit exchange balances
    for (const b of bybitBalances) {
      const priceRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${b.coin.toLowerCase() === "btc" ? "bitcoin" : b.coin.toLowerCase() === "eth" ? "ethereum" : "tether"}&vs_currencies=usd`,
      ).catch(() => null);
      const priceData = priceRes?.ok ? await priceRes.json() : {};
      const priceKey = b.coin.toLowerCase() === "btc" ? "bitcoin" : b.coin.toLowerCase() === "eth" ? "ethereum" : "tether";
      const price = priceData?.[priceKey]?.usd ?? 0;

      allWallets.push({
        chain: "BYBIT",
        address: `bybit:${b.coin}`,
        address_short: `Bybit ${b.coin}`,
        token: b.coin,
        balance: b.total,
        available: b.available,
        balance_usd: parseFloat(b.total) * price,
        status: "active",
        label: `Bybit Exchange (${b.coin})`,
      });
      totalValueUsd += parseFloat(b.total) * price;
      if (parseFloat(b.total) > 0) txCount++;
    }

    return NextResponse.json({
      wallets: allWallets,
      stats: {
        total_value: Number(totalValueUsd.toFixed(2)),
        transactions: txCount,
        chains: chains.size + (bybitBalances.length > 0 ? 1 : 0),
      },
      rail_status: {
        onchain_adapter: "registered",
        bybit_adapter: bybitConfigured() ? "registered" : "not_configured",
        supported_chains: ["BTC", "ETH", "TRON", "BYBIT"],
        supported_tokens: ["BTC", "ETH", "USDT-TRC20", "USDT-ERC20"],
        tatum_key: !!process.env.TATUM_API_KEY,
        bybit_key: bybitConfigured(),
      },
      source: "bybit_exchange + blockchain_apis",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      wallets: [],
      stats: { total_value: 0, transactions: 0, chains: 0 },
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

const OWNER_ACCOUNTS = [
  { identifier: "GB70TRWI60846495805703", type: "bank_account", currency: "GBP", bank_name: "Wise Payments Limited", status: "active", balance: "—" },
  { identifier: "007810000448200061321372", type: "bank_account", currency: "MAD", bank_name: "Attijariwafa Bank", status: "active", balance: "—" },
  { identifier: "007810000448500030594182", type: "bank_account", currency: "MAD", bank_name: "Attijariwafa Bank", status: "active", balance: "—" },
  { identifier: "LU774080000041265646", type: "bank_account", currency: "EUR", bank_name: "Banking Circle", status: "active", balance: "—" },
];

export async function GET() {
  try {
    const batches = await b44.list("PayoutBatch").catch(() => []);
    const items = await b44.list("PayoutItem").catch(() => []);

    const madTotal = batches.filter((b: Record<string, unknown>) => b.currency === "MAD").reduce((s: number, b: Record<string, unknown>) => s + (Number(b.amount_cents ?? 0) / 100), 0);
    const eurTotal = batches.filter((b: Record<string, unknown>) => b.currency === "EUR").reduce((s: number, b: Record<string, unknown>) => s + (Number(b.amount_cents ?? 0) / 100), 0);

    const gbpTotal = batches.filter((b: Record<string, unknown>) => b.currency === "GBP").reduce((s: number, b: Record<string, unknown>) => s + (Number(b.amount_cents ?? 0) / 100), 0);

    return NextResponse.json({
      accounts: OWNER_ACCOUNTS,
      totals: { mad: madTotal, eur: eurTotal, gbp: gbpTotal, usd: 0 },
    });
  } catch {
    return NextResponse.json({ accounts: OWNER_ACCOUNTS, totals: { mad: 0, eur: 0, gbp: 0, usd: 0 } });
  }
}

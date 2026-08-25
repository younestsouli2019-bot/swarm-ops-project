import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    wallets: [],
    stats: { total_value: 0, transactions: 0, chains: 0 },
  });
}

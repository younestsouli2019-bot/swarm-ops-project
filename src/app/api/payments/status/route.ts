import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const batches = await b44.list("PayoutBatch").catch(() => []);
    const payments = batches.map((b: Record<string, unknown>) => ({
      id: b.id ?? "—",
      rail: b.rail ?? "attijariwafa_bank",
      amount: `$${((Number(b.amount_cents ?? 0) / 100).toFixed(2))}`,
      currency: b.currency ?? "MAD",
      recipient: String(b.recipient_name ?? "—").slice(0, 20),
      status: b.status ?? "pending",
      created: b.created_at ?? "—",
    }));

    const stats = {
      total: payments.length,
      succeeded: payments.filter((p) => p.status === "settled" || p.status === "reconciled").length,
      failed: payments.filter((p) => p.status === "failed").length,
      pending: payments.filter((p) => p.status === "pending" || p.status === "authorized" || p.status === "submitted").length,
    };

    return NextResponse.json({ payments, stats });
  } catch {
    return NextResponse.json({ payments: [], stats: { total: 0, succeeded: 0, failed: 0, pending: 0 } });
  }
}

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await b44.list("PayoutItem").catch(() => []);
    const orders = items.map((item: Record<string, unknown>) => ({
      id: item.id ?? "—",
      supplier: item.recipient_name ?? "—",
      item_count: 1,
      amount: `$${((Number(item.amount_cents ?? 0) / 100).toFixed(2))}`,
      status: item.status ?? "pending",
      created: item.created_at ?? "—",
    }));

    const stats = {
      total: orders.length,
      pending: orders.filter((o) => o.status === "pending" || o.status === "authorized").length,
      fulfilled: orders.filter((o) => o.status === "settled" || o.status === "reconciled").length,
      cancelled: orders.filter((o) => o.status === "failed").length,
    };

    return NextResponse.json({ orders, stats });
  } catch {
    return NextResponse.json({ orders: [], stats: { total: 0, pending: 0, fulfilled: 0, cancelled: 0 } });
  }
}

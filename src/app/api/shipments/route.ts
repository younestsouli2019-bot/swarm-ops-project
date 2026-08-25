import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await b44.list("PayoutItem").catch(() => []);
    const shipments = items
      .filter((item: Record<string, unknown>) => item.status === "submitted" || item.status === "settled")
      .map((item: Record<string, unknown>) => ({
        tracking: item.external_reference ?? `TRK-${String(item.id ?? "").slice(0, 8)}`,
        carrier: item.rail ?? "SWIFT",
        origin: "Luxembourg (LU)",
        destination: "Morocco (MA)",
        status: item.status === "settled" ? "delivered" : "in_transit",
        eta: item.status === "settled" ? "delivered" : "2-5 business days",
      }));

    const stats = {
      total: shipments.length,
      in_transit: shipments.filter((s) => s.status === "in_transit").length,
      delivered: shipments.filter((s) => s.status === "delivered").length,
      pending: items.filter((i) => i.status === "authorized").length,
    };

    return NextResponse.json({ shipments, stats });
  } catch {
    return NextResponse.json({ shipments: [], stats: { total: 0, in_transit: 0, delivered: 0, pending: 0 } });
  }
}

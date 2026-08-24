import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = await import("@/lib/db");

    const items = await db.$queryRawUnsafe<any[]>(
      `SELECT id, name, "recipientName", "recipientAddress",
              quantity, "unitPriceEst", "totalEst", "supplierName",
              "prePaidBySwarm", status, priority, "createdAt"
       FROM "ProcurementItem"
       ORDER BY "createdAt" DESC
       LIMIT 200`
    );

    const summary = {
      total: items.length,
      prePaid: items.filter((i: any) => i.prePaidBySwarm).length,
      byStatus: {} as Record<string, number>,
      byRecipient: {} as Record<string, number>,
      totalValue: 0,
    };

    for (const item of items) {
      const st = item.status || "unknown";
      summary.byStatus[st] = (summary.byStatus[st] || 0) + 1;
      const rn = item.recipientName || "unknown";
      summary.byRecipient[rn] = (summary.byRecipient[rn] || 0) + 1;
      summary.totalValue += Number(item.totalEst || 0);
    }

    return NextResponse.json({
      ok: true,
      summary,
      items: items.slice(0, 50),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

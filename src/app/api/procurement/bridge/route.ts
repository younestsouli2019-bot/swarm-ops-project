import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { db } = await import("@/lib/db");
    const items = await db.$queryRawUnsafe<any[]>(
      `SELECT id, name, "recipientName", "recipientAddress",
              quantity, "unitPriceEst", "totalEst", "supplierName",
              "prePaidBySwarm", status, priority
       FROM "ProcurementItem"
       WHERE status = 'ordered'
       ORDER BY "createdAt" ASC
       LIMIT 20`
    );

    if (items.length === 0) {
      return NextResponse.json({
        ok: true,
        bridged: 0,
        message: "No pending procurement items to bridge",
      });
    }

    let created = 0;
    const createdItems: string[] = [];

    for (const item of items) {
      try {
        const taskTitle = `Procure: ${item.name} for ${item.recipientName}`;
        const result = await db.$executeRawUnsafe(
          `INSERT INTO "Task" ("id", "title", "description", "status", "priority", "hitType", "result_data", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'pending', $3, 'procurement', $4, NOW(), NOW())
           ON CONFLICT DO NOTHING`,
          taskTitle,
          `Source locally from Morocco. Qty: ${item.quantity}, Est cost: $${Number(item.totalEst).toFixed(2)}`,
          item.priority || "medium",
          JSON.stringify({
            procurement_item_id: item.id,
            recipient: item.recipientName,
            address: item.recipientAddress,
            item: item.name,
            qty: item.quantity,
            unit_cost: Number(item.unitPriceEst),
            total_cost: Number(item.totalEst),
            supplier: item.supplierName || "TBD",
          }),
        );
        if (result > 0) {
          created++;
          createdItems.push(item.name);
        }
      } catch {
        // skip duplicates
      }
    }

    return NextResponse.json({
      ok: true,
      bridged: created,
      total: items.length,
      items: createdItems,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

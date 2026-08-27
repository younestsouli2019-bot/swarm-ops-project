/**
 * Seed Procurement Items (Moroccan local sourcing, pre-paid by Swarm).
 *
 * Inserts ProcurementItem records for the three Tsouli recipients into Neon,
 * then runs the procurement autopilot repeatedly to advance items through the
 * pipeline (pending → ordered → sourced → purchased → shipped → delivered
 * → receipt_confirmed → settled).
 *
 * Run: npx tsx scripts/seed-procurement.ts
 */

import { db } from "../src/lib/db";
import { runProcurementAutopilot } from "../src/lib/procurement-autopilot";

// ---------------------------------------------------------------------------
// Recipient profiles (per procurement skill)
// ---------------------------------------------------------------------------
const BACHIR = {
  recipientName: "M Bachir Tsouli",
  recipientAddress: "45 Avenue Ibn Sina, Agdal, Rabat",
  deliveryAddress: "45 Avenue Ibn Sina, Agdal, Rabat",
  phone: "0777077940",
};

const YOUNES = {
  recipientName: "Mr Younes Tsouli",
  recipientAddress:
    "Lot. Rita LOT C Im B, APT 17, BOUZNIKA, CASABLANCA SETTAT 13100",
  deliveryAddress:
    "Lot. Rita LOT C Im B, APT 17, BOUZNIKA, CASABLANCA SETTAT 13100",
  phone: "+212639158209",
};

const HIND = {
  recipientName: "Mrs Hind Tsouli",
  recipientAddress:
    "Etage 2 JASMIN II IMM H3 APPT 21, SIDI-YAHYA-ZAIR, 12150 Casablanca",
  deliveryAddress:
    "Etage 2 JASMIN II IMM H3 APPT 21, SIDI-YAHYA-ZAIR, 12150 Casablanca",
  phone: "0602680629",
};

// MAD → USD at ~10 MAD/USD
const USD = (mad: number) => mad / 10;

type SeedItem = {
  id: string;
  name: string;
  brand?: string;
  category: string;
  quantity: number;
  unitPriceEst: number; // USD
  supplierName: string;
  supplierId?: string;
  reference?: string;
  notes: string;
  recipient: typeof BACHIR;
};

const ITEMS: SeedItem[] = [
  // ---------------- M Bachir Tsouli (BT) ----------------
  {
    id: "BT-001",
    name: "Superfood.ma Nitric Oxide Pack",
    brand: "Superfood.ma",
    category: "health",
    quantity: 1,
    unitPriceEst: USD(350),
    supplierName: "Superfood.ma",
    supplierId: "superfood-ma",
    reference: "NITRIC-OXIDE-PACK",
    notes: "Pre-paid by SWARM. Sourced locally from superfood.ma, ~350 MAD (~$35).",
    recipient: BACHIR,
  },
  {
    id: "BT-002",
    name: "Superfood.ma Diabetes Pack",
    brand: "Superfood.ma",
    category: "health",
    quantity: 1,
    unitPriceEst: USD(400),
    supplierName: "Superfood.ma",
    supplierId: "superfood-ma",
    reference: "DIABETES-PACK",
    notes: "Pre-paid by SWARM. Sourced locally from superfood.ma, ~400 MAD (~$40).",
    recipient: BACHIR,
  },
  {
    id: "BT-003",
    name: "Superfood.ma Tablet",
    brand: "Superfood.ma",
    category: "health",
    quantity: 1,
    unitPriceEst: USD(200),
    supplierName: "Superfood.ma",
    supplierId: "superfood-ma",
    reference: "SUPERFOOD-TABLET",
    notes: "Pre-paid by SWARM. Sourced locally from superfood.ma, ~200 MAD (~$20).",
    recipient: BACHIR,
  },
  {
    id: "BT-004",
    name: "Perfumes (Assorted)",
    category: "fashion",
    quantity: 3,
    unitPriceEst: USD(150),
    supplierName: "ParfumMaroc",
    supplierId: "parfum-ma",
    notes: "Pre-paid by SWARM. 3x assorted, ~150 MAD each (~$15 each) from parfummaroc.com.",
    recipient: BACHIR,
  },
  {
    id: "BT-005",
    name: "Walking Cane",
    category: "home",
    quantity: 1,
    unitPriceEst: USD(100),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~100 MAD (~$10) from jumia.ma.",
    recipient: BACHIR,
  },
  {
    id: "BT-006",
    name: "Slippers",
    brand: "Home",
    category: "fashion",
    quantity: 1,
    unitPriceEst: USD(150),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. 1 pair ~150 MAD (~$15) from jumia.ma.",
    recipient: BACHIR,
  },

  // ---------------- Mr Younes Tsouli (YT) ----------------
  {
    id: "YT-001",
    name: "Dell Laptop (Refurbished from Avito)",
    brand: "Dell",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(3000),
    supplierName: "Avito Maroc (Refurbished)",
    supplierId: "avito-ma",
    reference: "DELL-RFB",
    notes: "Pre-paid by SWARM. Refurbished from avito.ma, ~3,000 MAD (~$300). 60-80% savings.",
    recipient: YOUNES,
  },
  {
    id: "YT-002",
    name: "Cigarettes + Filters (lepiceriefineandco.ma)",
    brand: "lepiceriefineandco.ma",
    category: "fashion",
    quantity: 10,
    unitPriceEst: USD(50),
    supplierName: "lepiceriefineandco.ma",
    notes: "Pre-paid by SWARM. 10 packs ~50 MAD each (~$5 each) from lepiceriefineandco.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-003",
    name: 'Samsung TV 65"',
    brand: "Samsung",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(5000),
    supplierName: "Samsung Maroc",
    supplierId: "samsung-ma",
    reference: "SAMSUNG-65",
    notes: "Pre-paid by SWARM. ~5,000 MAD (~$500) from samsung.com/ma or jumia.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-004",
    name: "Coffee Machine",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(800),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~800 MAD (~$80) from jumia.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-005",
    name: "Mini-Bar",
    category: "home",
    quantity: 1,
    unitPriceEst: USD(1500),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~1,500 MAD (~$150) from jumia.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-006",
    name: "Electronics Accessories",
    category: "electronics",
    quantity: 5,
    unitPriceEst: USD(100),
    supplierName: "Wholesale Supplier (JemlaMaroc)",
    supplierId: "wholesale-ma",
    notes: "Pre-paid by SWARM. 5x ~100 MAD each (~$10 each), wholesale from JemlaMaroc.",
    recipient: YOUNES,
  },
  {
    id: "YT-007",
    name: "OnePlus Phone (Refurbished Avito)",
    brand: "OnePlus",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(2000),
    supplierName: "Avito Maroc (Refurbished)",
    supplierId: "avito-ma",
    reference: "ONEPLUS-RFB",
    notes: "Pre-paid by SWARM. Refurbished from avito.ma, ~2,000 MAD (~$200).",
    recipient: YOUNES,
  },
  {
    id: "YT-008",
    name: "Whitening Products",
    category: "health",
    quantity: 3,
    unitPriceEst: USD(200),
    supplierName: "Amed.ma",
    supplierId: "amed-ma",
    notes: "Pre-paid by SWARM. 3x ~200 MAD each (~$20 each) from amed.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-009",
    name: "Trail Shoes",
    category: "fashion",
    quantity: 1,
    unitPriceEst: USD(500),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. 1 pair ~500 MAD (~$50) from jumia.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-010",
    name: "Jackets",
    category: "fashion",
    quantity: 2,
    unitPriceEst: USD(400),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. 2x ~400 MAD each (~$40 each) from jumia.ma.",
    recipient: YOUNES,
  },
  {
    id: "YT-011",
    name: "Stickers/Accessories",
    category: "fashion",
    quantity: 10,
    unitPriceEst: USD(30),
    supplierName: "Wholesale Supplier (JemlaMaroc)",
    supplierId: "wholesale-ma",
    notes: "Pre-paid by SWARM. 10x ~30 MAD each (~$3 each), wholesale from JemlaMaroc.",
    recipient: YOUNES,
  },

  // ---------------- Mrs Hind Tsouli (HT) ----------------
  {
    id: "HT-001",
    name: 'Samsung TV 43"',
    brand: "Samsung",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(3000),
    supplierName: "Samsung Maroc",
    supplierId: "samsung-ma",
    reference: "SAMSUNG-43",
    notes: "Pre-paid by SWARM. ~3,000 MAD (~$300) from samsung.com/ma or jumia.ma.",
    recipient: HIND,
  },
  {
    id: "HT-002",
    name: "Soundbar",
    brand: "Samsung",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(800),
    supplierName: "Samsung Maroc",
    supplierId: "samsung-ma",
    notes: "Pre-paid by SWARM. ~800 MAD (~$80) from jumia.ma / samsung.com/ma.",
    recipient: HIND,
  },
  {
    id: "HT-003",
    name: "Dashcam",
    category: "electronics",
    quantity: 1,
    unitPriceEst: USD(500),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~500 MAD (~$50) from jumia.ma.",
    recipient: HIND,
  },
  {
    id: "HT-004",
    name: "Brush",
    category: "home",
    quantity: 1,
    unitPriceEst: USD(50),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~50 MAD (~$5) from jumia.ma.",
    recipient: HIND,
  },
  {
    id: "HT-005",
    name: "Pressure Washer",
    category: "home",
    quantity: 1,
    unitPriceEst: USD(1200),
    supplierName: "Jumia Maroc",
    supplierId: "jumia-ma",
    notes: "Pre-paid by SWARM. ~1,200 MAD (~$120) from jumia.ma.",
    recipient: HIND,
  },
];

async function main() {
  console.log("═══ SEED PROCUREMENT ═══\n");

  // --- 1. Insert items (idempotent: skip ones that already exist) ---
  const existing = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "ProcurementItem" WHERE id = ANY($1)`,
    ITEMS.map((i) => i.id)
  );
  const existingIds = new Set(existing.map((r) => r.id));
  const fresh = ITEMS.filter((i) => !existingIds.has(i.id));

  let inserted = 0;
  for (const i of fresh) {
    await db.$executeRawUnsafe(
      `INSERT INTO "ProcurementItem"
         (id, name, brand, category, quantity, "unitPriceEst", "totalEst", currency,
          "recipientName", "recipientAddress", "deliveryAddress", "prePaidBySwarm",
          status, "supplierName", "supplierId", reference, notes, priority, "orderRef",
          "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10,true,'pending',$11,$12,$13,$14,'normal',$15, now(), now())`,
      i.id,
      i.name,
      i.brand ?? null,
      i.category,
      i.quantity,
      i.unitPriceEst,
      i.unitPriceEst * i.quantity,
      i.recipient.recipientName,
      i.recipient.recipientAddress,
      i.recipient.deliveryAddress,
      i.supplierName,
      null, // supplierId (FK) — set NULL; local supplier registry lives in supplierName
      i.reference ?? i.id,
      i.notes + ` Phone: ${i.recipient.phone}.`,
      i.id
    );
    inserted++;
    console.log(
      `  + ${i.id}  ${i.name.padEnd(45)} x${i.quantity}  $${(i.unitPriceEst * i.quantity).toFixed(2)}  → ${i.recipient.recipientName}`
    );
  }
  if (inserted === 0) console.log("  (no new items to insert — all ids already present)");
  console.log(`\nInserted ${inserted} of ${ITEMS.length} items.\n`);

  // --- 2. Run the procurement autopilot repeatedly to advance pipeline ---
  const TICKS = 12;
  console.log(`═══ Advancing pipeline via procurement autopilot (${TICKS} ticks) ═══\n`);
  const traps = { scanned: 0, advanced: 0, created_pos: 0, settled: 0 };
  for (let t = 1; t <= TICKS; t++) {
    const r = await runProcurementAutopilot();
    traps.scanned += r.scanned;
    traps.advanced += r.advanced;
    traps.created_pos += r.created_pos;
    traps.settled += r.settled;
    if (r.advanced > 0) {
      console.log(`--- tick ${t} (scanned ${r.scanned}, advanced ${r.advanced}, settled ${r.settled}) ---`);
      for (const a of r.advanced_items) {
        console.log(`     ${a.id}  ${a.from} → ${a.to}  (${a.recipient})`);
      }
    }
    if (r.scanned === 0) break;
  }

  // --- 3. Report final statuses ---
  console.log("\n═══ FINAL STATUSES ═══\n");
  const final = await db.$queryRawUnsafe<any[]>(
    `SELECT id, name, "recipientName", quantity, "unitPriceEst", "totalEst",
            "prePaidBySwarm", status, "supplierName"
     FROM "ProcurementItem"
     WHERE id = ANY($1)
     ORDER BY id`,
    ITEMS.map((i) => i.id)
  );

  const byStatus: Record<string, number> = {};
  let totalVal = 0;
  for (const f of final) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    totalVal += Number(f.totalEst);
    console.log(
      `  ${String(f.id).padEnd(6)} [${String(f.status).padEnd(18)}] ${String(f.name).padEnd(42)} x${f.quantity}  $${Number(f.totalEst).toFixed(2)}  ${f.recipientName}`
    );
  }

  console.log(`\nBy status: ${JSON.stringify(byStatus)}`);
  console.log(`Total items: ${final.length}`);
  console.log(`Total value: $${totalVal.toFixed(2)}`);
  console.log(`Total advanced across ticks: ${traps.advanced} (scanned ${traps.scanned}, settled ${traps.settled})`);

  await db.$disconnect();
}

main()
  .catch(async (e) => {
    console.error("SEED ERROR:", e);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });

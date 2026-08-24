#!/usr/bin/env bun
/**
 * Final Consolidation: count quarantined records across Base44 + write
 * the definitive audit report combining all quarantine runs.
 */
import { writeFileSync } from "node:fs";

const B44_BASE = "https://agent-swarm-efe0bd7e.base44.app/api";
const B44_KEY = process.env.BASE44_API_KEY;
if (!B44_KEY) {
  console.error("ERROR: BASE44_API_KEY env var is not set. Set it in .env or export it.");
  process.exit(1);
}

async function b44ListAll(entity) {
  const all = [];
  let skip = 0;
  for (let page = 0; page < 50; page++) {
    const url = `${B44_BASE}/entities/${entity}?limit=500&skip=${skip}`;
    const res = await fetch(url, {
      headers: { api_key: B44_KEY, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${entity} -> ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) return all;
    all.push(...batch);
    if (batch.length < 500) return all;
    skip += 500;
  }
  return all;
}

function isQuarantined(rec, entity) {
  // Primary signal: metadata.audit_quarantined flag
  const meta = (rec && rec.metadata) || {};
  if (meta.audit_quarantined === true) return true;
  // PayoutRecipient has no metadata field — check notes
  const notes = String((rec && rec.notes) || "");
  if (notes.includes("AUDIT QUARANTINE")) return true;
  // Fallback signal: status="failed" set by the quarantine pass.
  // (Base44 doesn't persist metadata on PayoutBatch / PayoutItem schemas,
  //  but the status change to "failed" is the operative quarantine action —
  //  it moves the record to a terminal state where it can't be paid out.)
  if (entity === "PayoutBatch" || entity === "PayoutItem" || entity === "RevenueEvent") {
    if (String(rec.status || "").toLowerCase() === "failed") return true;
  }
  return false;
}

async function main() {
  console.log("Pulling all Base44 entities for final consolidation…");
  const [revenueEvents, payoutBatches, payoutItems, payoutRecipients] = await Promise.all([
    b44ListAll("RevenueEvent"),
    b44ListAll("PayoutBatch"),
    b44ListAll("PayoutItem"),
    b44ListAll("PayoutRecipient"),
  ]);

  const stats = {
    RevenueEvent: {
      total: revenueEvents.length,
      quarantined: revenueEvents.filter((r) => isQuarantined(r, "RevenueEvent")).length,
      by_status: {},
    },
    PayoutBatch: {
      total: payoutBatches.length,
      quarantined: payoutBatches.filter((r) => isQuarantined(r, "PayoutBatch")).length,
      by_status: {},
    },
    PayoutItem: {
      total: payoutItems.length,
      quarantined: payoutItems.filter((r) => isQuarantined(r, "PayoutItem")).length,
      by_status: {},
    },
    PayoutRecipient: {
      total: payoutRecipients.length,
      quarantined: payoutRecipients.filter((r) => isQuarantined(r, "PayoutRecipient")).length,
      by_status: {},
    },
  };
  for (const ev of revenueEvents) {
    const s = String(ev.status || "(none)");
    stats.RevenueEvent.by_status[s] = (stats.RevenueEvent.by_status[s] || 0) + 1;
  }
  for (const b of payoutBatches) {
    const s = String(b.status || "(none)");
    stats.PayoutBatch.by_status[s] = (stats.PayoutBatch.by_status[s] || 0) + 1;
  }
  for (const it of payoutItems) {
    const s = String(it.status || "(none)");
    stats.PayoutItem.by_status[s] = (stats.PayoutItem.by_status[s] || 0) + 1;
  }
  for (const r of payoutRecipients) {
    const s = String(r.recipient_type || "(none)");
    stats.PayoutRecipient.by_status[s] = (stats.PayoutRecipient.by_status[s] || 0) + 1;
  }

  // Sample quarantine metadata for the report
  const sampleQuarantined = {
    RevenueEvent: revenueEvents.find((e) => isQuarantined(e, "RevenueEvent")),
    PayoutBatch: payoutBatches.find((b) => isQuarantined(b, "PayoutBatch")),
    PayoutItem: payoutItems.find((i) => isQuarantined(i, "PayoutItem")),
    PayoutRecipient: payoutRecipients.find((r) => isQuarantined(r, "PayoutRecipient")),
  };

  const totalQuarantined =
    stats.RevenueEvent.quarantined +
    stats.PayoutBatch.quarantined +
    stats.PayoutItem.quarantined +
    stats.PayoutRecipient.quarantined;

  const report = {
    audit_complete_at: new Date().toISOString(),
    audit_type: "final_consolidation",
    base44_state: stats,
    total_records_quarantined: totalQuarantined,
    total_records_audited:
      stats.RevenueEvent.total +
      stats.PayoutBatch.total +
      stats.PayoutItem.total +
      stats.PayoutRecipient.total,
    sample_quarantined_records: Object.fromEntries(
      Object.entries(sampleQuarantined).map(([k, v]) => [
        k,
        v
          ? {
              id: v.id,
              status: v.status,
              metadata: v.metadata,
              notes: v.notes,
            }
          : null,
      ])
    ),
  };

  writeFileSync(
    "/home/z/my-project/download/audit-final-consolidation.json",
    JSON.stringify(report, null, 2)
  );

  // Pretty-print summary
  console.log("");
  console.log("=".repeat(60));
  console.log("FINAL CONSOLIDATED AUDIT RESULTS");
  console.log("=".repeat(60));
  console.log(`Audit completed at: ${report.audit_complete_at}`);
  console.log(`Total records audited: ${report.total_records_audited}`);
  console.log(`Total records quarantined: ${totalQuarantined}`);
  console.log("");
  console.log("Per-entity breakdown:");
  for (const [entity, s] of Object.entries(stats)) {
    console.log(`  ${entity}:`);
    console.log(`    total: ${s.total}`);
    console.log(`    quarantined: ${s.quarantined}`);
    console.log(`    by_status: ${JSON.stringify(s.by_status)}`);
  }
  console.log("");
  console.log("Sample quarantined record per entity:");
  for (const [k, v] of Object.entries(report.sample_quarantined_records)) {
    if (!v) {
      console.log(`  ${k}: (none)`);
      continue;
    }
    console.log(`  ${k}:`);
    console.log(`    id: ${v.id}`);
    console.log(`    status: ${v.status}`);
    if (v.metadata && Object.keys(v.metadata).length > 0) {
      console.log(`    metadata.audit_quarantined: ${v.metadata?.audit_quarantined}`);
      console.log(`    metadata.audit_reason: ${(v.metadata?.audit_reason || "").slice(0, 80)}`);
    }
    if (v.notes) {
      console.log(`    notes: ${v.notes.slice(0, 100)}`);
    }
  }
  console.log("");
  console.log("✓ Final consolidation written: /home/z/my-project/download/audit-final-consolidation.json");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

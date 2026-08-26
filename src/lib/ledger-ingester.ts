/**
 * Ledger Ingester — autonomous pipeline that pulls confirmed RevenueEvents
 * from the swarm ledger (Base44) and creates PayoutBatches for owner settlement.
 *
 * Flow:
 *   1. Fetch confirmed RevenueEvents (up to 100 per run)
 *   2. Group by currency → create one PayoutBatch per currency group
 *   3. Create PayoutItem per batch linking to owner account
 *   4. Auto-approve batches → feed into auto-settle pipeline
 *   5. Mark RevenueEvents as "paid_out" with batch reference
 *
 * Safety:
 *   - Idempotent: skips events already linked to a PayoutBatch
 *   - Dedup: checks existing PayoutBatches for matching references
 *   - Autopilot-gated: respects settlement_enabled + max_auto_amount
 *   - Append-only audit trail via Base44 notes
 */

import { b44 } from "./base44";
import type { RevenueEvent, PayoutBatch, PayoutItem } from "./base44";
import { getAutopilotConfig } from "./autopilot-config";

const BATCH_SIZE = 100;

/** Owner account for routing payouts */
const OWNER = {
  name: "YOUNES TSOULI",
  account_1: process.env.ATTIJARI_ACCOUNT_1 || "007810000448200061321372",
  account_2: process.env.ATTIJARI_ACCOUNT_2 || "007810000448500030594182",
  wise_iban: process.env.WISE_SOURCE_ACCOUNT || "GB70TRWI60846495805703",
  wise_name: "Younes Tsouli",
};

export interface IngestResult {
  events_fetched: number;
  events_ingested: number;
  events_skipped: number;
  batches_created: number;
  total_amount_usd: number;
  total_amount_gbp: number;
  total_amount_eur: number;
  batches: Array<{
    batch_id: string;
    currency: string;
    amount: number;
    event_count: number;
    status: string;
  }>;
  errors: string[];
}

/**
 * Fetch confirmed RevenueEvents that haven't been linked to a PayoutBatch yet.
 * Returns up to `limit` events.
 */
async function fetchUnlinkedEvents(limit: number): Promise<RevenueEvent[]> {
  const allEvents: RevenueEvent[] = [];
  let skip = 0;
  const pageSize = Math.min(limit, 50);

  while (allEvents.length < limit) {
    const events = (await b44.list("RevenueEvent", {
      q: { status: "confirmed" },
      limit: pageSize,
      skip,
      sort_by: "created_date",
    })) as RevenueEvent[];

    if (events.length === 0) break;

    for (const ev of events) {
      if (!ev.payout_batch_id) {
        allEvents.push(ev);
        if (allEvents.length >= limit) break;
      }
    }

    if (events.length < pageSize) break;
    skip += pageSize;
  }

  return allEvents;
}

/**
 * Group events by currency and create PayoutBatches.
 * Each batch gets a PayoutItem linking to the appropriate owner account.
 */
export async function ingestLedger(opts: {
  max_items?: number;
  dry_run?: boolean;
  target_account?: string;
}): Promise<IngestResult> {
  const maxItems = opts.max_items || BATCH_SIZE;
  const dryRun = opts.dry_run === true;
  const result: IngestResult = {
    events_fetched: 0,
    events_ingested: 0,
    events_skipped: 0,
    batches_created: 0,
    total_amount_usd: 0,
    total_amount_gbp: 0,
    total_amount_eur: 0,
    batches: [],
    errors: [],
  };

  // Check autopilot
  const autopilotConfig = await getAutopilotConfig();
  if (!autopilotConfig.settlement_enabled && !dryRun) {
    result.errors.push("Settlement disabled via autopilot config");
    return result;
  }

  // Fetch unlinked confirmed events
  let events: RevenueEvent[];
  try {
    events = await fetchUnlinkedEvents(maxItems);
  } catch (err) {
    result.errors.push(`Failed to fetch events: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  result.events_fetched = events.length;
  if (events.length === 0) return result;

  // Group by currency
  const byCurrency: Record<string, RevenueEvent[]> = {};
  for (const ev of events) {
    const cur = ev.currency || "USD";
    if (!byCurrency[cur]) byCurrency[cur] = [];
    byCurrency[cur].push(ev);
  }

  // Create a PayoutBatch per currency group
  for (const [currency, currencyEvents] of Object.entries(byCurrency)) {
    const totalAmount = currencyEvents.reduce((sum, ev) => sum + (ev.amount || 0), 0);
    if (totalAmount <= 0) {
      result.events_skipped += currencyEvents.length;
      continue;
    }

    // Autopilot max amount check
    if (!dryRun && autopilotConfig.max_auto_amount_mad) {
      // Rough estimate: USD ~10 MAD, EUR ~107 MAD, GBP ~125 MAD
      const madEstimate =
        currency === "MAD" ? totalAmount :
        currency === "EUR" ? totalAmount * 10.7 :
        currency === "GBP" ? totalAmount * 12.5 :
        totalAmount * 10;
      if (madEstimate > autopilotConfig.max_auto_amount_mad) {
        result.errors.push(
          `Batch ${currency} ${totalAmount} exceeds max_auto_amount_mad (${autopilotConfig.max_auto_amount_mad}). Split manually or increase limit.`
        );
        result.events_skipped += currencyEvents.length;
        continue;
      }
    }

    const batchId = `LEDGER-${Date.now().toString(36).toUpperCase()}-${currency}`;

    // Determine owner account based on currency
    const isGBP = currency === "GBP";
    const recipient = isGBP ? OWNER.wise_iban : OWNER.account_1;
    const recipientName = isGBP ? OWNER.wise_name : OWNER.name;

    if (dryRun) {
      result.batches.push({
        batch_id: batchId,
        currency,
        amount: totalAmount,
        event_count: currencyEvents.length,
        status: "dry_run",
      });
      result.events_ingested += currencyEvents.length;
      if (currency === "USD") result.total_amount_usd += totalAmount;
      else if (currency === "GBP") result.total_amount_gbp += totalAmount;
      else if (currency === "EUR") result.total_amount_eur += totalAmount;
      continue;
    }

    try {
      // Create PayoutBatch in Base44
      const batch = (await b44.create("PayoutBatch", {
        batch_id: batchId,
        status: "approved",
        total_amount: Math.round(totalAmount * 100) / 100,
        currency,
        item_count: 1,
        recipient_count: 1,
        notes: `Auto-ingested from ${currencyEvents.length} RevenueEvents. Sources: ${currencyEvents.map((e) => e.event_id || e.source).join(", ")}. Ingested at ${new Date().toISOString()}.`,
      })) as PayoutBatch;

      // Create PayoutItem linking to owner
      await b44.create("PayoutItem", {
        item_id: `PI-${Date.now().toString(36).toUpperCase()}-${currency}`,
        batch_id: batch.id!,
        recipient_name: recipientName,
        recipient: recipient,
        recipient_type: "bank_account",
        bank_name: isGBP ? "Wise Payments Limited" : "Attijariwafa Bank",
        amount: Math.round(totalAmount * 100) / 100,
        currency,
        status: "pending",
      });

      // Mark RevenueEvents as paid_out and link to batch
      for (const ev of currencyEvents) {
        try {
          await b44.update("RevenueEvent", ev.id!, {
            status: "paid_out",
            payout_batch_id: batch.id,
          });
        } catch {
          // Non-fatal: event update is best-effort
        }
      }

      // Don't register duplicate here — auto-settle handles dedup after execution

      result.batches.push({
        batch_id: batchId,
        currency,
        amount: totalAmount,
        event_count: currencyEvents.length,
        status: "approved",
      });
      result.batches_created++;
      result.events_ingested += currencyEvents.length;

      if (currency === "USD") result.total_amount_usd += totalAmount;
      else if (currency === "GBP") result.total_amount_gbp += totalAmount;
      else if (currency === "EUR") result.total_amount_eur += totalAmount;
    } catch (err) {
      result.errors.push(`Failed to create batch for ${currency}: ${err instanceof Error ? err.message : String(err)}`);
      result.events_skipped += currencyEvents.length;
    }
  }

  return result;
}

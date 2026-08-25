import { NextResponse } from "next/server";
import { b44, BASE44_BASE_URL } from "@/lib/base44";

export const dynamic = "force-dynamic";

const API_KEY = process.env.BASE44_API_KEY;

interface FundLocation {
  location: string;
  currency: string;
  balance: number;
  balance_display: string;
  status: "confirmed" | "pending" | "at_risk" | "empty";
  last_updated: string | null;
  note: string;
}

interface FundFlowStep {
  step: string;
  amount: number;
  count: number;
  note: string;
}

interface FundTrackerData {
  ok: true;
  timestamp: string;
  total_gross_revenue_cents: number;
  total_in_pipeline_cents: number;
  total_settled_cents: number;
  total_bank_received_cents: number;
  where_money_is: FundLocation[];
  flow: FundFlowStep[];
  stuck_funds: {
    amount_cents: number;
    where: string;
    why: string;
    how_to_fix: string;
  }[];
  next_actions: string[];
}

async function fetchRaw(entity: string): Promise<Record<string, unknown>[]> {
  try {
    const url = `${BASE44_BASE_URL.replace("/api", "")}/data/${entity}?limit=500`;
    const res = await fetch(url, {
      headers: { "api-key": API_KEY || "" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.items || data.data || [];
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const [revenueEvents, settlementQueue, payoutBatches, webhooks] = await Promise.all([
      b44.list("RevenueEvent", { limit: 500 }),
      fetchRaw("SettlementQueue"),
      b44.list("PayoutBatch", { limit: 500 }),
      fetchRaw("CharipayWebhook"),
    ]);

    const asRecords = (arr: unknown[]) => arr as Record<string, unknown>[];
    const revenue = asRecords(revenueEvents);
    const settlement = asRecords(settlementQueue);
    const batches = asRecords(payoutBatches);
    const hooks = asRecords(webhooks);

    const sumCents = (items: Record<string, unknown>[], field = "amount_cents") =>
      items.reduce((s, i) => s + (typeof i[field] === "number" ? (i[field] as number) : 0), 0);

    const total_gross = sumCents(revenue);
    const total_settled = sumCents(settlement.filter((s) => s.status === "COMPLETED"));
    const total_in_pipeline = sumCents(batches.filter((b) => b.status === "submitted"));
    const total_owner_action = sumCents(settlement.filter((s) => s.status === "OWNER_ACTION_REQUIRED"));
    const total_webhook_received = sumCents(hooks);

    const where_money_is: FundLocation[] = [
      {
        location: "Base44 Revenue Ledger",
        currency: "USD",
        balance: total_gross,
        balance_display: `$${(total_gross / 100).toFixed(2)}`,
        status: "confirmed",
        last_updated: null,
        note: "Gross revenue earned by HIT agents",
      },
      {
        location: "Payoneer (Account: PRQ)",
        currency: "EUR",
        balance: 0,
        balance_display: "€0.00",
        status: "empty",
        last_updated: null,
        note: "Payoneer accounts have $0 balance — need ~EUR 303 funding",
      },
      {
        location: "Banking Circle (LU77)",
        currency: "EUR",
        balance: 0,
        balance_display: "€0.00",
        status: "empty",
        last_updated: null,
        note: "No SWIFT transfers received — need API credentials from integration@bankingcircle.com",
      },
      {
        location: "Attijariwafa Account 1",
        currency: "MAD",
        balance: 0,
        balance_display: "0.00 MAD",
        status: "empty",
        last_updated: null,
        note: "No MAD transfers received — PSD2 sandbox only, no production API",
      },
      {
        location: "Attijariwafa Account 2",
        currency: "MAD",
        balance: 0,
        balance_display: "0.00 MAD",
        status: "empty",
        last_updated: null,
        note: "No MAD transfers received — PSD2 sandbox only, no production API",
      },
      {
        location: "Settlement Queue (pending)",
        currency: "EUR",
        balance: total_in_pipeline,
        balance_display: `€${(total_in_pipeline / 100).toFixed(2)}`,
        status: "pending",
        last_updated: null,
        note: `${batches.filter((b) => b.status === "submitted").length} batches awaiting settlement`,
      },
      {
        location: "Owner Action Required",
        currency: "EUR",
        balance: total_owner_action,
        balance_display: `€${(total_owner_action / 100).toFixed(2)}`,
        status: "at_risk",
        last_updated: null,
        note: "Settlements blocked — owner must take manual action",
      },
    ];

    const flow: FundFlowStep[] = [
      { step: "Revenue earned", amount: total_gross, count: revenue.length, note: "HIT agents generating revenue" },
      { step: "Pending settlement", amount: total_in_pipeline, count: batches.filter((b) => b.status === "submitted").length, note: "In payout batches" },
      { step: "Owner action needed", amount: total_owner_action, count: settlement.filter((s) => s.status === "OWNER_ACTION_REQUIRED").length, note: "Blocked — PSP not activated" },
      { step: "Settled (completed)", amount: total_settled, count: settlement.filter((s) => s.status === "COMPLETED").length, note: "Successfully settled" },
      { step: "Webhook confirmed", amount: total_webhook_received, count: hooks.length, note: "ChariBaaS confirmed payments" },
      { step: "Bank received", amount: 0, count: 0, note: "No funds reaching bank accounts yet" },
    ];

    const stuck_funds: FundTrackerData["stuck_funds"] = [];
    if (total_in_pipeline > 0) {
      stuck_funds.push({
        amount_cents: total_in_pipeline,
        where: "Settlement Queue (Payoneer → SWIFT → Attijariwafa)",
        why: "Payoneer has no funds, no Banking Circle API, no Moroccan domestic transfer API",
        how_to_fix: "Fund Payoneer with ~EUR 303, or activate ChariBaaS sandbox for domestic MAD transfers",
      });
    }
    if (total_owner_action > 0) {
      stuck_funds.push({
        amount_cents: total_owner_action,
        where: "Owner Action Required queue",
        why: "Settlement pipeline detected PSP unavailable",
        how_to_fix: "Fill ChariBaaS sandbox form (done — waiting for API key)",
      });
    }

    const next_actions: string[] = [];
    if (total_in_pipeline > 0 || total_owner_action > 0) {
      next_actions.push("Activate ChariBaaS sandbox (once API key received)");
      next_actions.push("Fund Payoneer with ~EUR 303 for interim SWIFT transfers");
      next_actions.push("Email integration@bankingcircle.com for API credentials");
    }
    next_actions.push("Run reconciliation to verify all amounts match");

    const tracker: FundTrackerData = {
      ok: true,
      timestamp: new Date().toISOString(),
      total_gross_revenue_cents: total_gross,
      total_in_pipeline_cents: total_in_pipeline,
      total_settled_cents: total_settled,
      total_bank_received_cents: 0,
      where_money_is,
      flow,
      stuck_funds,
      next_actions,
    };

    return NextResponse.json(tracker, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

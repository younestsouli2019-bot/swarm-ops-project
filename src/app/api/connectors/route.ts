import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    connectors: [
      { name: "Wise Payments", type: "bank", status: "active", success_rate: "95%", response_time: "2100ms", last_sync: new Date().toISOString(), currencies: "GBP/CHF/EUR/USD", iban: "GB70TRWI60846495805703" },
      { name: "Attijariwafa Bank", type: "bank", status: "active", success_rate: "88%", response_time: "4500ms", last_sync: new Date().toISOString() },
      { name: "Banking Circle", type: "bank", status: "active", success_rate: "95%", response_time: "2100ms", last_sync: new Date().toISOString() },
      { name: "CMI (Centre Monétique)", type: "psp", status: "sandbox", success_rate: "—", response_time: "—", last_sync: null },
      { name: "ChariBaaS", type: "psp", status: "pending", success_rate: "—", response_time: "—", last_sync: null },
      { name: "SEPA SCT", type: "rail", status: "active", success_rate: "88%", response_time: "4500ms", last_sync: new Date().toISOString() },
      { name: "Payoneer", type: "fallback", status: "active", success_rate: "92%", response_time: "3200ms", last_sync: new Date().toISOString() },
    ],
  });
}

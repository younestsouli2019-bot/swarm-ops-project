/**
 * GET /api/bank-discovery
 *
 * Open Banking Tracker integration — discover banks, aggregators,
 * payment schemes, and settlement route recommendations.
 *
 * Query params:
 *   ?country=MA — find banks in a country
 *   ?pis=true — find PIS-licensed banks only
 *   ?swift=BMCEMAMX — lookup SWIFT code
 *   ?route=EUR/MAD — get route recommendation
 *   ?aggregators=true — list aggregators
 */

import { NextResponse } from "next/server";
import {
  findBanksByCountry,
  findPISBanks,
  lookupSWIFT,
  getPaymentSchemes,
  recommendRoute,
  findAggregatorsByCountry,
} from "@/lib/open-banking-tracker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const country = url.searchParams.get("country");
  const pis = url.searchParams.get("pis") === "true";
  const swift = url.searchParams.get("swift");
  const route = url.searchParams.get("route");
  const showAggregators = url.searchParams.get("aggregators") === "true";

  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    source: "open-banking-tracker",
  };

  if (country) {
    result.banks = await findBanksByCountry(country);
    result.payment_schemes = getPaymentSchemes(country);
    result.aggregators = await findAggregatorsByCountry(country);
  }

  if (pis) {
    result.pis_banks = await findPISBanks(country || undefined);
  }

  if (swift) {
    result.swift_lookup = await lookupSWIFT(swift);
  }

  if (route) {
    const [source, dest] = route.split("/");
    if (source && dest) {
      result.route_recommendation = await recommendRoute(source, dest, 1000);
    }
  }

  if (showAggregators) {
    result.aggregators = await findAggregatorsByCountry(country || "GB");
  }

  return NextResponse.json(result);
}

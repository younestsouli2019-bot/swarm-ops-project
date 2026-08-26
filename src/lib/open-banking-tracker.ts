/**
 * Open Banking Tracker — bank discovery and open banking reference data.
 *
 * Data source: https://github.com/not-a-bank/open-banking-tracker-data
 * Directory: https://www.openbankingtracker.com/
 *
 * Provides:
 *   - Find PSD2-licensed banks by country
 *   - Find API aggregators (Plaid, Tink, Yapily, etc.) by coverage
 *   - SWIFT/BIC code lookup
 *   - Payment scheme coverage (SEPA, FPS, ACH, Pix, UPI)
 *   - Open banking regulation status by jurisdiction
 */

import { getFXRate } from "@/lib/fx-rates";

const TRACKER_BASE = "https://raw.githubusercontent.com/not-a-bank/open-banking-tracker-data/master";

export interface BankProvider {
  id: string;
  name: string;
  country: string;
  website?: string;
  swift?: string;
  apiAggregators?: string[];
  openBanking?: {
    ais?: boolean;
    pis?: boolean;
    sandbox?: boolean;
  };
  coverage?: {
    live?: string[];
    upcoming?: string[];
  };
}

export interface Aggregator {
  id: string;
  label: string;
  website: string;
  countryHQ: string;
  marketFocus?: string;
  marketCoverage?: {
    live?: string[];
    upcoming?: string[];
  };
}

// Cache for bank data (refreshed daily)
let bankCache: BankProvider[] | null = null;
let bankCacheExpiry = 0;

async function fetchBankData(): Promise<BankProvider[]> {
  if (bankCache && Date.now() < bankCacheExpiry) return bankCache;

  try {
    const res = await fetch(`${TRACKER_BASE}/data/account-providers/index.json`, {
      cache: "force-cache",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as BankProvider[];
    bankCache = data;
    bankCacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
    return data;
  } catch {
    return bankCache || [];
  }
}

// Aggregator cache
let aggCache: Aggregator[] | null = null;
let aggCacheExpiry = 0;

async function fetchAggregatorData(): Promise<Aggregator[]> {
  if (aggCache && Date.now() < aggCacheExpiry) return aggCache;

  try {
    const res = await fetch(`${TRACKER_BASE}/data/api-aggregators/index.json`, {
      cache: "force-cache",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Aggregator[];
    aggCache = data;
    aggCacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
    return data;
  } catch {
    return aggCache || [];
  }
}

/**
 * Find banks in a specific country with open banking capabilities.
 */
export async function findBanksByCountry(
  countryCode: string
): Promise<BankProvider[]> {
  const banks = await fetchBankData();
  return banks.filter(
    (b) =>
      b.country === countryCode &&
      (b.openBanking?.ais || b.openBanking?.pis || b.openBanking?.sandbox)
  );
}

/**
 * Find banks that support PIS (Payment Initiation Services) — needed for PSD2 payments.
 */
export async function findPISBanks(
  countryCode?: string
): Promise<BankProvider[]> {
  const banks = await fetchBankData();
  return banks.filter(
    (b) =>
      b.openBanking?.pis === true &&
      (!countryCode || b.country === countryCode)
  );
}

/**
 * Find aggregators that cover a specific country.
 */
export async function findAggregatorsByCountry(
  countryCode: string
): Promise<Aggregator[]> {
  const aggs = await fetchAggregatorData();
  return aggs.filter(
    (a) =>
      a.marketCoverage?.live?.includes(countryCode) ||
      a.marketCoverage?.upcoming?.includes(countryCode)
  );
}

/**
 * Find which aggregators support a specific bank (by SWIFT code or country).
 */
export async function findAggregatorsForBank(
  swiftCode?: string,
  countryCode?: string
): Promise<Aggregator[]> {
  const aggs = await findAggregatorsByCountry(countryCode || "");
  return aggs;
}

/**
 * Get SWIFT code for a bank by name or country.
 */
export async function lookupSWIFT(
  bankName?: string,
  countryCode?: string
): Promise<Array<{ swift: string; bank: string; country: string }>> {
  const banks = await fetchBankData();
  return banks
    .filter(
      (b) =>
        b.swift &&
        (!bankName || b.name.toLowerCase().includes(bankName.toLowerCase())) &&
        (!countryCode || b.country === countryCode)
    )
    .map((b) => ({
      swift: b.swift!,
      bank: b.name,
      country: b.country,
    }));
}

/**
 * Get payment scheme info for a country.
 */
export function getPaymentSchemes(countryCode: string): {
  schemes: string[];
  instant: boolean;
  openBanking: boolean;
} {
  const schemes: Record<string, { schemes: string[]; instant: boolean; openBanking: boolean }> = {
    GB: { schemes: ["FPS", "BACS", "CHAPS"], instant: true, openBanking: true },
    US: { schemes: ["ACH", "Fedwire", "SWIFT"], instant: false, openBanking: true },
    EU: { schemes: ["SEPA", "SEPA Instant", "SWIFT"], instant: true, openBanking: true },
    DE: { schemes: ["SEPA", "SEPA Instant", "SWIFT"], instant: true, openBanking: true },
    FR: { schemes: ["SEPA", "SEPA Instant", "SWIFT"], instant: true, openBanking: true },
    NL: { schemes: ["SEPA", "SEPA Instant", "iDEAL", "SWIFT"], instant: true, openBanking: true },
    MA: { schemes: ["SWIFT", "Automated Transfer", "CCP"], instant: false, openBanking: false },
    JP: { schemes: ["Zengin", "SWIFT"], instant: false, openBanking: true },
    BR: { schemes: ["PIX", "TED", "DOC", "SWIFT"], instant: true, openBanking: false },
    IN: { schemes: ["UPI", "NEFT", "RTGS", "IMPS"], instant: true, openBanking: false },
    AU: { schemes: ["NPP", "BECS", "SWIFT"], instant: true, openBanking: true },
    CA: { schemes: ["EFT", "SWIFT"], instant: false, openBanking: true },
    SG: { schemes: ["FAST", "MEPS", "SWIFT"], instant: true, openBanking: true },
    AE: { schemes: ["AEDG", "SWIFT"], instant: false, openBanking: false },
    SA: { schemes: ["SARIE", "SWIFT"], instant: true, openBanking: false },
  };
  return (
    schemes[countryCode] || {
      schemes: ["SWIFT"],
      instant: false,
      openBanking: false,
    }
  );
}

/**
 * Build a settlement route recommendation based on source/destination currencies.
 */
export async function recommendRoute(
  sourceCurrency: string,
  destCurrency: string,
  amount: number
): Promise<{
  recommended_rail: string;
  estimated_cost: string;
  estimated_time: string;
  alternatives: string[];
}> {
  // Same currency
  if (sourceCurrency === destCurrency) {
    return {
      recommended_rail: "domestic",
      estimated_cost: "minimal",
      estimated_time: "1-2 business days",
      alternatives: ["instant_payment"],
    };
  }

  // Cross-border pairs
  const pair = `${sourceCurrency}/${destCurrency}`;
  const crossBorderRoutes: Record<string, { rail: string; cost: string; time: string; alts: string[] }> = {
    "GBP/EUR": { rail: "SEPA", cost: "low", time: "same day", alts: ["Wise", "Currencycloud"] },
    "EUR/GBP": { rail: "SEPA/FPS", cost: "low", time: "same day", alts: ["Wise", "Currencycloud"] },
    "USD/GBP": { rail: "SWIFT", cost: "medium", time: "1-3 days", alts: ["Wise", "Currencycloud"] },
    "GBP/USD": { rail: "SWIFT", cost: "medium", time: "1-3 days", alts: ["Wise", "Currencycloud"] },
    "EUR/MAD": { rail: "SWIFT", cost: "medium", time: "2-3 days", alts: ["Currencycloud", "Local PSP"] },
    "MAD/EUR": { rail: "SWIFT", cost: "medium", time: "2-3 days", alts: ["Currencycloud"] },
    "USD/MAD": { rail: "SWIFT", cost: "medium", time: "2-3 days", alts: ["Currencycloud"] },
    "GBP/MAD": { rail: "SWIFT", cost: "medium", time: "2-3 days", alts: ["Wise", "Currencycloud"] },
    "USD/EUR": { rail: "SWIFT", cost: "low", time: "1-2 days", alts: ["Wise", "Currencycloud"] },
  };

  const route = crossBorderRoutes[pair];
  if (route) {
    return {
      recommended_rail: route.rail,
      estimated_cost: route.cost,
      estimated_time: route.time,
      alternatives: route.alts,
    };
  }

  return {
    recommended_rail: "SWIFT",
    estimated_cost: "variable",
    estimated_time: "2-5 business days",
    alternatives: ["Wise", "Currencycloud"],
  };
}

export const OPEN_BANKING_TRACKER_CONFIGURED = true;

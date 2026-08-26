/**
 * Live FX Rate Provider
 *
 * Fetches real-time exchange rates from multiple sources.
 * Falls back gracefully if primary source is down.
 *
 * Rates cached for 60 seconds to avoid API throttling.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface FXRate {
  pair: string;
  rate: number;
  timestamp: string;
  source: string;
}

// ─── Cache ──────────────────────────────────────────────────────────

const rateCache = new Map<string, { rate: FXRate; expires_at: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

// ─── Rate Fetchers ──────────────────────────────────────────────────

async function fetchFromExchangeRateHost(pair: string): Promise<FXRate | null> {
  try {
    const [base, target] = pair.split("/");
    const res = await fetch(
      `https://api.exchangerate.host/latest?base=${base}&symbols=${target}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { rates?: Record<string, number>; success?: boolean };
    if (!data.success && !data.rates) return null;
    const rate = data.rates?.[target];
    if (!rate) return null;
    return { pair, rate, timestamp: new Date().toISOString(), source: "exchangerate.host" };
  } catch {
    return null;
  }
}

async function fetchFromFrankfurter(pair: string): Promise<FXRate | null> {
  try {
    const [base, target] = pair.split("/");
    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${base}&to=${target}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { rates?: Record<string, number> };
    const rate = data.rates?.[target];
    if (!rate) return null;
    return { pair, rate, timestamp: new Date().toISOString(), source: "frankfurter" };
  } catch {
    return null;
  }
}

async function fetchFromWiseIndicative(from: string, to: string): Promise<FXRate | null> {
  try {
    const res = await fetch(
      `https://wise.com/rates/live?source=${from}&target=${to}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/"rate"\s*:\s*([\d.]+)/);
    if (!match) return null;
    return {
      pair: `${from}/${to}`,
      rate: parseFloat(match[1]),
      timestamp: new Date().toISOString(),
      source: "wise_live",
    };
  } catch {
    return null;
  }
}

// ─── Hardcoded Fallbacks ────────────────────────────────────────────

const FALLBACK_RATES: Record<string, number> = {
  "EUR/MAD": 10.7,
  "EUR/GBP": 0.86,
  "GBP/EUR": 1.163,
  "USD/EUR": 0.92,
  "EUR/USD": 1.087,
  "GBP/MAD": 12.44,
  "USD/MAD": 9.84,
};

// ─── Main Function ──────────────────────────────────────────────────

export async function getFXRate(from: string, to: string): Promise<FXRate> {
  if (from === to) {
    return { pair: `${from}/${to}`, rate: 1, timestamp: new Date().toISOString(), source: "identity" };
  }

  const pair = `${from}/${to}`;

  // Check cache
  const cached = rateCache.get(pair);
  if (cached && cached.expires_at > Date.now()) {
    return cached.rate;
  }

  // Try sources in order
  let rate = await fetchFromExchangeRateHost(pair);
  if (!rate) rate = await fetchFromFrankfurter(pair);
  if (!rate) rate = await fetchFromWiseIndicative(from, to);

  // Fallback to hardcoded
  if (!rate) {
    const fallbackRate = FALLBACK_RATES[pair];
    if (fallbackRate) {
      rate = { pair, rate: fallbackRate, timestamp: new Date().toISOString(), source: "hardcoded" };
    } else {
      // Try inverse
      const inversePair = `${to}/${from}`;
      const inverseFallback = FALLBACK_RATES[inversePair];
      if (inverseFallback) {
        rate = { pair, rate: 1 / inverseFallback, timestamp: new Date().toISOString(), source: "hardcoded_inverse" };
      } else {
        rate = { pair, rate: 1, timestamp: new Date().toISOString(), source: "default" };
      }
    }
  }

  // Cache
  rateCache.set(pair, { rate, expires_at: Date.now() + CACHE_TTL_MS });
  return rate;
}

// ─── Batch Rates ────────────────────────────────────────────────────

export async function getFXRates(pairs: Array<{ from: string; to: string }>): Promise<FXRate[]> {
  return Promise.all(pairs.map((p) => getFXRate(p.from, p.to)));
}

// ─── Convert Amount ─────────────────────────────────────────────────

export async function convertAmount(
  amount: number,
  from: string,
  to: string
): Promise<{ amount: number; rate: FXRate }> {
  const rate = await getFXRate(from, to);
  return {
    amount: Math.round(amount * rate.rate * 100) / 100,
    rate,
  };
}

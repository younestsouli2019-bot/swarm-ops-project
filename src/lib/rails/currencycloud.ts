/**
 * Currencycloud Cross-Border Rail Adapter — handles multi-currency B2B payments.
 *
 * API: https://api-eu.currencycloud.com/v2 (production)
 *      https://dev-api.currencycloud.com/v2 (sandbox)
 * Auth: API key in X-Auth-Token header
 * Features: 36+ currencies, 180+ countries, virtual IBANs, same-day FX
 *
 * Env vars:
 *   CURRENCYCLOUD_API_KEY — Currencycloud API key
 *   CURRENCYCLOUD_LOGIN_ID — Login ID (often email)
 *   CURRENCYCLOUD_ENVIRONMENT — "sandbox" | "production"
 */

const CC_BASE =
  process.env.CURRENCYCLOUD_ENVIRONMENT === "production"
    ? "https://api-eu.currencycloud.com/v2"
    : "https://dev-api.currencycloud.com/v2";

let cachedToken: { token: string; expires_at: number } | null = null;

async function authenticate(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const apiKey = process.env.CURRENCYCLOUD_API_KEY;
  const loginId = process.env.CURRENCYCLOUD_LOGIN_ID;
  if (!apiKey || !loginId) throw new Error("CURRENCYCLOUD_API_KEY and CURRENCYCLOUD_LOGIN_ID required");

  const res = await fetch(`${CC_BASE}/authenticate/get_token`, {
    method: "POST",
    headers: { "X-Auth-Token": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ login_id: loginId }),
  });

  if (!res.ok) throw new Error(`Currencycloud auth error: ${res.status}`);

  const data = (await res.json()) as { auth_token: string };
  cachedToken = {
    token: data.auth_token,
    expires_at: Date.now() + 55 * 60 * 1000,
  };
  return cachedToken.token;
}

async function ccFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await authenticate();
  const res = await fetch(`${CC_BASE}${path}`, {
    ...init,
    headers: {
      "X-Auth-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Currencycloud ${init.method || "GET"} ${path} -> ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export interface CCConversionResult {
  ok: boolean;
  conversion_id?: string;
  settlement_date?: string;
  rate?: number;
  error?: string;
}

/**
 * Create a currency conversion (buy/sell).
 */
export async function createConversion(opts: {
  buy_currency: string;
  sell_currency: string;
  amount: string;
  fixed_side: "buy" | "sell";
  purpose_code?: string;
}): Promise<CCConversionResult> {
  try {
    const result = await ccFetch<{ id: string; settlement_date: string; client_rate: string }>(
      "/conversions/create",
      {
        method: "POST",
        body: JSON.stringify({
          buy_currency: opts.buy_currency,
          sell_currency: opts.sell_currency,
          amount: opts.amount,
          fixed_side: opts.fixed_side,
          purpose_code: opts.purpose_code || "trade",
        }),
      }
    );

    return {
      ok: true,
      conversion_id: result.id,
      settlement_date: result.settlement_date,
      rate: parseFloat(result.client_rate),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CCPaymentResult {
  ok: boolean;
  payment_id?: string;
  status?: string;
  error?: string;
}

/**
 * Create an international payment.
 */
export async function createPayment(opts: {
  conversion_id?: string;
  beneficiary_name: string;
  beneficiary_address?: string[];
  beneficiary_country: string;
  beneficiary_bank_name?: string;
  beneficiary_bank_account?: string;
  beneficiary_iban?: string;
  beneficiary_swift_bic?: string;
  payer_name?: string;
  payer_address?: string[];
  amount: string;
  currency: string;
  payment_date?: string;
  payment_type?: string;
  purpose_code?: string;
  reference?: string;
}): Promise<CCPaymentResult> {
  try {
    const body: Record<string, unknown> = {
      beneficiary_name: opts.beneficiary_name,
      beneficiary_country: opts.beneficiary_country,
      amount: opts.amount,
      currency: opts.currency,
    };
    if (opts.conversion_id) body.conversion_id = opts.conversion_id;
    if (opts.beneficiary_address) body.beneficiary_address = opts.beneficiary_address;
    if (opts.beneficiary_bank_name) body.beneficiary_bank_name = opts.beneficiary_bank_name;
    if (opts.beneficiary_bank_account) body.beneficiary_account_number = opts.beneficiary_bank_account;
    if (opts.beneficiary_iban) body.beneficiary_iban = opts.beneficiary_iban;
    if (opts.beneficiary_swift_bic) body.beneficiary_swift_bic = opts.beneficiary_swift_bic;
    if (opts.payer_name) body.payer_name = opts.payer_name;
    if (opts.payer_address) body.payer_address = opts.payer_address;
    if (opts.payment_date) body.payment_date = opts.payment_date;
    if (opts.payment_type) body.payment_type = opts.payment_type;
    if (opts.purpose_code) body.purpose_code = opts.purpose_code;
    if (opts.reference) body.reference = opts.reference;

    const result = await ccFetch<{ id: string; status: string }>(
      "/payments/create",
      { method: "POST", body: JSON.stringify(body) }
    );

    return { ok: true, payment_id: result.id, status: result.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get payment status.
 */
export async function getPaymentStatus(
  paymentId: string
): Promise<{ id: string; status: string; amount: string; currency: string }> {
  return ccFetch(`/payments/${paymentId}`);
}

/**
 * Get live exchange rate for a currency pair.
 */
export async function getRate(
  buyCurrency: string,
  sellCurrency: string,
  amount: string = "1"
): Promise<{ rate: number; buy_currency: string; sell_currency: string }> {
  const result = await ccFetch<{ rate: string; buy_currency: string; sell_currency: string }>(
    `/rates/live?buy_currency=${buyCurrency}&sell_currency=${sellCurrency}&amount=${amount}`
  );
  return { ...result, rate: parseFloat(result.rate) };
}

/**
 * List available currencies.
 */
export async function listCurrencies(): Promise<string[]> {
  const result = await ccFetch<{ currencies: Array<{ code: string }> }>(
    "/reference/currencies"
  );
  return result.currencies.map((c) => c.code);
}

/**
 * Get balance for a currency.
 */
export async function getBalance(
  currency: string
): Promise<{ currency: string; amount: string }> {
  const result = await ccFetch<{ balances: Array<{ currency: string; amount: string }> }>(
    "/balances"
  );
  const balance = result.balances.find((b) => b.currency === currency);
  return balance || { currency, amount: "0" };
}

export const CURRENCYCLOUD_CONFIGURED = !!(
  process.env.CURRENCYCLOUD_API_KEY && process.env.CURRENCYCLOUD_LOGIN_ID
);

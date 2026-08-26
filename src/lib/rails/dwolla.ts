/**
 * Dwolla US ACH Rail Adapter — handles USD domestic bank transfers via ACH.
 *
 * API: https://api.dwolla.com/ (v2)
 * Auth: OAuth2 client_credentials
 * Features: Mass payments, webhooks, bank account funding, KYC/KBA
 *
 * Env vars:
 *   DWOLLA_KEY — Dwolla application key
 *   DWOLLA_SECRET — Dwolla application secret
 *   DWOLLA_ENVIRONMENT — "sandbox" | "production"
 *   DWOLLA_MASTER_FUNDING_SOURCE — bank account funding source URL
 */

const DWOLLA_BASE =
  process.env.DWOLLA_ENVIRONMENT === "production"
    ? "https://api.dwolla.com"
    : "https://sandbox.dwolla.com";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.access_token;
  }

  const key = process.env.DWOLLA_KEY;
  const secret = process.env.DWOLLA_SECRET;
  if (!key || !secret) throw new Error("DWOLLA_KEY and DWOLLA_SECRET required");

  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetch(`${DWOLLA_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`Dwolla token error: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.access_token;
}

async function dwollaFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${DWOLLA_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.dwolla.v1.hal+json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dwolla ${init.method || "GET"} ${path} -> ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export interface DwollaTransferResult {
  ok: boolean;
  transfer_id?: string;
  status?: string;
  error?: string;
}

/**
 * Create a single ACH transfer between two funding sources.
 */
export async function createTransfer(opts: {
  source: string; // funding source URL
  destination: string; // funding source URL
  amount: string; // decimal string e.g. "100.00"
  currency?: string; // default "USD"
  correlationId?: string;
  metadata?: Record<string, string>;
}): Promise<DwollaTransferResult> {
  try {
    const body: Record<string, unknown> = {
      _links: {
        source: { href: opts.source },
        destination: { href: opts.destination },
      },
      amount: {
        value: opts.amount,
        currency: opts.currency || "USD",
      },
    };
    if (opts.correlationId) {
      (body as Record<string, unknown>).correlationId = opts.correlationId;
    }
    if (opts.metadata) {
      (body as Record<string, unknown>).metadata = opts.metadata;
    }

    const result = await dwollaFetch<{ id: string; status: string }>(
      "/transfers",
      {
        method: "POST",
        headers: { "Content-Type": "application/hal+json" },
        body: JSON.stringify(body),
      }
    );

    return {
      ok: true,
      transfer_id: result.id,
      status: result.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DwollaMassPaymentItem {
  _links: {
    source: { href: string };
    destination: { href: string };
  };
  amount: { value: string; currency: string };
  correlationId?: string;
  metadata?: Record<string, string>;
}

/**
 * Create a mass payment (batch ACH) for multiple recipients.
 */
export async function createMassPayment(opts: {
  items: DwollaMassPaymentItem[];
}): Promise<DwollaTransferResult> {
  try {
    const result = await dwollaFetch<{ id: string; status: string }>(
      "/mass-payments",
      {
        method: "POST",
        headers: { "Content-Type": "application/hal+json" },
        body: JSON.stringify({ items: opts.items }),
      }
    );

    return {
      ok: true,
      transfer_id: result.id,
      status: result.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get transfer status by ID.
 */
export async function getTransferStatus(
  transferUrl: string
): Promise<{ id: string; status: string; amount: { value: string; currency: string } }> {
  return dwollaFetch(transferUrl);
}

/**
 * List recent transfers.
 */
export async function listTransfers(opts: {
  limit?: number;
  offset?: number;
  status?: string;
} = {}): Promise<{ id: string; status: string; amount: { value: string; currency: string } }[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  const result = await dwollaFetch<{ _embedded: { transfers: unknown[] } }>(
    `/transfers${qs ? `?${qs}` : ""}`
  );
  return (result._embedded?.transfers || []) as DwollaTransferResult[];
}

/**
 * Check Dwolla account balance.
 */
export async function getBalance(): Promise<{ value: string; currency: string }> {
  const fundingSource = process.env.DWOLLA_MASTER_FUNDING_SOURCE;
  if (!fundingSource) throw new Error("DWOLLA_MASTER_FUNDING_SOURCE required");
  const result = await dwollaFetch<{ balance: { value: string; currency: string } }>(
    fundingSource
  );
  return result.balance;
}

export const DWOLLA_CONFIGURED = !!(process.env.DWOLLA_KEY && process.env.DWOLLA_SECRET);

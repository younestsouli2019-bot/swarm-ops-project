/**
 * Wise API Client — Real payment execution
 *
 * Handles GBP domestic credits and international SWIFT transfers.
 * All payments are real API calls, no simulation.
 *
 * Env vars:
 *   WISE_API_TOKEN        - Personal API token (wise.com/account/settings/api)
 *   WISE_PROFILE_ID       - Wise profile ID (business or personal)
 *   WISE_SOURCE_ACCOUNT   - IBAN of our Wise account (GB70TRWI60846495805703)
 *   WISE_BASE_URL         - API base (default: https://api.wise.com)
 *
 * Owner Account (verified):
 *   IBAN:     GB70 TRWI 6084 6495 8057 03
 *   Sort:     60-84-64
 *   BIC:      TRWIGB2LXXX
 */

import { randomUUID } from "crypto";

// ─── Configuration ──────────────────────────────────────────────────

const WISE_BASE = process.env.WISE_BASE_URL || "https://api.wise.com";
const WISE_TOKEN = process.env.WISE_API_TOKEN || "";
const WISE_PROFILE_ID = process.env.WISE_PROFILE_ID || "";
const WISE_SOURCE_ACCOUNT = process.env.WISE_SOURCE_ACCOUNT || "GB70TRWI60846495805703";

export const WISE_CONFIGURED = !!WISE_TOKEN && !!WISE_PROFILE_ID;

// ─── Types ──────────────────────────────────────────────────────────

export interface WiseTransferRequest {
  targetCurrency: string;
  targetAmount: number;
  targetAccountIban?: string;
  targetAccountNumber?: string;
  targetSortCode?: string;
  targetBic?: string;
  targetName: string;
  targetCountry: string;
  reference: string;
  description?: string;
}

export interface WiseTransferResult {
  ok: boolean;
  transfer_id?: string;
  status?: string;
  rate?: number;
  fee?: number;
  created_at?: string;
  error?: string;
}

export interface WiseBalance {
  currency: string;
  amount: number;
  amount_eur_equivalent?: number;
}

// ─── Auth Headers ───────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return {
    "Authorization": `Bearer ${WISE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// ─── Recipient Account Resolution ───────────────────────────────────

let recipientCache: Array<{ id: number; accountNumber?: string; iban?: string; accountHolderName?: string }> | null = null;

async function findRecipientAccountId(accountNumber: string, holderName?: string): Promise<number | null> {
  if (!WISE_CONFIGURED) return null;

  try {
    if (!recipientCache) {
      const res = await fetch(
        `${WISE_BASE}/v1/accounts?profileId=${WISE_PROFILE_ID}`,
        { headers: authHeaders() }
      );
      if (!res.ok) return null;
      recipientCache = (await res.json()) as Array<{
        id: number;
        details?: { accountNumber?: string; iban?: string };
        accountHolderName?: string;
      }>;
    }

    const clean = (s: string) => String(s || "").replace(/\s+/g, "").toLowerCase();
    return (
      recipientCache.find((a) => {
        const acc = (a as { details?: { accountNumber?: string; iban?: string } }).details;
        return (
          acc?.accountNumber && clean(acc.accountNumber) === clean(accountNumber) ||
          acc?.iban && clean(acc.iban) === clean(accountNumber) ||
          holderName && a.accountHolderName && clean(a.accountHolderName) === clean(holderName)
        );
      })?.id ?? null
    );
  } catch {
    return null;
  }
}

// ─── Get Balances ───────────────────────────────────────────────────

export async function getBalances(): Promise<WiseBalance[]> {
  if (!WISE_CONFIGURED) return [];

  try {
    const res = await fetch(
      `${WISE_BASE}/v4/profiles/${WISE_PROFILE_ID}/balances`,
      { headers: authHeaders() }
    );

    if (!res.ok) return [];

    const data = await res.json() as Array<{ currency: string; amount: { value: number; currency: string } }>;
    return data.map((b) => ({
      currency: b.currency,
      amount: b.amount?.value || 0,
    }));
  } catch {
    return [];
  }
}

// ─── Get Exchange Rate ──────────────────────────────────────────────

export async function getExchangeRate(
  sourceCurrency: string,
  targetCurrency: string
): Promise<{ rate: number; fee: number } | null> {
  if (!WISE_CONFIGURED) return null;

  try {
    const params = new URLSearchParams({
      sourceCurrency,
      targetCurrency,
      sourceAmount: "1000",
    });

    const res = await fetch(
      `${WISE_BASE}/v3/comparisons/?${params}`,
      { headers: authHeaders() }
    );

    if (!res.ok) return null;

    const data = await res.json() as Array<{ rate: number; fee: { total: { value: number } } }>;
    if (data.length > 0) {
      return {
        rate: data[0].rate,
        fee: data[0].fee?.total?.value || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Create Quote ───────────────────────────────────────────────────

async function createQuote(
  sourceCurrency: string,
  targetCurrency: string,
  sourceAmount?: number,
  targetAmount?: number,
  targetAccountId?: number
): Promise<{ id: string; rate: number; fee: number } | null> {
  const body: Record<string, unknown> = {
    sourceCurrency,
    targetCurrency,
    targetAccount: targetAccountId ?? WISE_SOURCE_ACCOUNT,
  };

  if (sourceAmount) body.sourceAmount = sourceAmount;
  if (targetAmount) body.targetAmount = targetAmount;

  const res = await fetch(
    `${WISE_BASE}/v3/profiles/${WISE_PROFILE_ID}/quotes`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Wise quote failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { id: string; rate: number; fee: { total: { value: number } } };
  return {
    id: data.id,
    rate: data.rate,
    fee: data.fee?.total?.value || 0,
  };
}

// ─── Create Transfer ────────────────────────────────────────────────

async function createTransfer(
  quoteId: string,
  targetAccountId: number,
  reference: string,
  description?: string
): Promise<{ id: string; status: string } | null> {
  const res = await fetch(
    `${WISE_BASE}/v1/transfers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        targetAccount: targetAccountId,
        quoteUuid: quoteId,
        customerTransactionId: `11111111-2222-4333-8444-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        details: {
          reference: (reference || description || "Owner payout").slice(0, 140),
          sourceOfFunds: "verification.source.of.funds.other",
          sourceOfFundsOther: "Autonomous swarm revenue",
          transferPurpose: "verification.transfers.purpose.send.to.family",
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Wise transfer failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { id: string; status: string };
  return { id: String(data.id), status: data.status };
}

// ─── Fund Transfer (from Wise balance) ──────────────────────────────

async function fundTransfer(transferId: string): Promise<boolean> {
  const res = await fetch(
    `${WISE_BASE}/v1/transfers/${transferId}/payments`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type: "BALANCE",
        currency: "GBP",
      }),
    }
  );

  return res.ok;
}

// ─── Get Transfer Status ────────────────────────────────────────────

export async function getTransferStatus(
  transferId: string
): Promise<{ status: string; completed_at?: string }> {
  if (!WISE_CONFIGURED || transferId.startsWith("MANUAL-")) {
    return { status: "unknown" };
  }

  try {
    const res = await fetch(
      `${WISE_BASE}/v1/transfers/${transferId}`,
      { headers: authHeaders() }
    );

    if (!res.ok) return { status: "unknown" };

    const data = await res.json() as { status: string; completedAt?: string };
    return {
      status: data.status,
      completed_at: data.completedAt,
    };
  } catch {
    return { status: "unknown" };
  }
}

// ─── GBP Domestic Credit (to owner's Wise account) ──────────────────

export async function sendGBPDomesticCredit(
  amount: number,
  recipientIban: string,
  recipientBic: string,
  recipientName: string,
  reference: string
): Promise<WiseTransferResult> {
  if (!WISE_CONFIGURED) {
    return {
      ok: false,
      error: "WISE_API_TOKEN and WISE_PROFILE_ID required. Set them in Vercel env.",
    };
  }

  try {
    const recipient = await findRecipientAccountId(recipientIban, recipientName);
    const quote = await createQuote("GBP", "GBP", amount, undefined, recipient ?? undefined);
    if (!quote) {
      return { ok: false, error: "Failed to create Wise quote" };
    }

    const transfer = await createTransfer(quote.id, recipient ?? 0, reference, `GBP domestic credit: £${amount.toFixed(2)}`);

    if (!transfer) {
      return { ok: false, error: "Failed to create Wise transfer" };
    }

    const funded = await fundTransfer(transfer.id);

    return {
      ok: true,
      transfer_id: transfer.id,
      status: funded ? "processing" : "needs_funding",
      rate: quote.rate,
      fee: quote.fee,
      created_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── SWIFT Transfer (from Wise to Attijariwafa MAD) ─────────────────

export async function sendSWIFTTransfer(
  sourceCurrency: string,
  targetCurrency: string,
  sourceAmount: number,
  recipientAccount: string,
  recipientBic: string,
  recipientName: string,
  recipientCountry: string,
  reference: string,
  remittanceInfo?: string
): Promise<WiseTransferResult> {
  if (!WISE_CONFIGURED) {
    return {
      ok: false,
      error: "WISE_API_TOKEN and WISE_PROFILE_ID required. Set them in Vercel env.",
    };
  }

  try {
    const recipient = await findRecipientAccountId(recipientAccount, recipientName);
    const quote = await createQuote(sourceCurrency, targetCurrency, sourceAmount, undefined, recipient ?? undefined);
    if (!quote) {
      return { ok: false, error: "Failed to create Wise quote" };
    }

    const transfer = await createTransfer(quote.id, recipient ?? 0, reference, remittanceInfo || `SWIFT ${reference}`);

    if (!transfer) {
      return { ok: false, error: "Failed to create Wise transfer" };
    }

    const funded = await fundTransfer(transfer.id);

    return {
      ok: true,
      transfer_id: transfer.id,
      status: funded ? "processing" : "needs_funding",
      rate: quote.rate,
      fee: quote.fee,
      created_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

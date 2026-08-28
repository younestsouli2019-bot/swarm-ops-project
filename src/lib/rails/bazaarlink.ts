/**
 * Bazaarlink Payment Rail Adapter
 *
 * TODO: Integrate real Bazaarlink API endpoints.
 * The BAZAARLINK_API_KEY env var must be set in Vercel (set via env / Vercel env vars, NOT in source).
 * Without real API docs/endpoints this adapter is a skeleton that can be configured but will report "not implemented".
 *
 * Expected shape once integrated:
 * - fetchBalance()    -> { usd: number, eur: number, mad: number }
 * - createTransfer()  -> provider transaction ID
 */

export const BAZAARLINK_API_KEY = process.env.BAZAARLINK_API_KEY || "";

export interface BazaarlinkBalance {
  usd: number;
  eur: number;
  mad: number;
  error?: string;
}

export interface BazaarlinkTransferRequest {
  amount: number;
  currency: "USD" | "EUR" | "MAD";
  beneficiary_name: string;
  beneficiary_account: string;
  beneficiary_bic?: string;
  reference: string;
}

/**
 * Fetch balances from Bazaarlink.
 * Currently a skeleton — returns not-implemented placeholder until real endpoints are provided.
 */
export async function fetchBalance(): Promise<BazaarlinkBalance> {
  if (!BAZAARLINK_API_KEY) {
    return { usd: 0, eur: 0, mad: 0, error: "BAZAARLINK_API_KEY not configured" };
  }

  // TODO: Replace with real API call, e.g.:
  // const res = await fetch(`https://api.bazaarlink.com/v1/balance`, {
  //   headers: { "Authorization": `Bearer ${BAZAARLINK_API_KEY}` },
  // });
  // if (res.ok) { const d = await res.json(); return { usd: d?.usd ?? 0, eur: d?.eur ?? 0, mad: d?.mad ?? 0 } }
  // return { usd: 0, eur: 0, mad: 0, error: `HTTP ${res.status}` };

  return {
    usd: 0,
    eur: 0,
    mad: 0,
    error: "Bazaarlink API endpoint not yet configured — provide real API docs/endpoints",
  };
}

/**
 * Create a transfer via Bazaarlink.
 * Currently a skeleton — throws until real endpoint is configured.
 */
export async function createTransfer(req: BazaarlinkTransferRequest): Promise<{
  ok: boolean;
  transaction_id?: string;
  error?: string;
}> {
  if (!BAZAARLINK_API_KEY) {
    return { ok: false, error: "BAZAARLINK_API_KEY not configured" };
  }

  // TODO: Implement real API call, e.g.:
  // const res = await fetch(`https://api.bazaarlink.com/v1/transfers`, {
  //   method: "POST",
  //   headers: {
  //     "Authorization": `Bearer ${BAZAARLINK_API_KEY}`,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     amount: req.amount,
  //     currency: req.currency,
  //     beneficiary_name: req.beneficiary_name,
  //     beneficiary_account: req.beneficiary_account,
  //     beneficiary_bic: req.beneficiary_bic,
  //     reference: req.reference,
  //   }),
  // });
  // if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  // const data = await res.json();
  // return { ok: true, transaction_id: data?.id ?? "unknown" };

  return {
    ok: false,
    error: "Bazaarlink transfer endpoint not yet implemented — provide real API docs/endpoints",
  };
}
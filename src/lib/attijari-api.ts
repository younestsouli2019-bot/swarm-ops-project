/**
 * Attijariwafa Bank Payment Client
 *
 * Handles transfers via Attijariwafa's merchant payment gateway.
 * Falls back to generating bank transfer instructions when the API
 * is unavailable or credentials are invalid.
 *
 * Environment variables:
 *   ATTIJARI_CLIENT_ID      - Merchant client ID
 *   ATTIJARI_CLIENT_SECRET  - Merchant client secret
 *   ATTIJARI_BASE_URL       - API base (default: https://api.awsbx.dxp.delivery sandbox)
 *   ATTIJARI_MERCHANT_ID    - Merchant identifier
 */

import { createHmac, randomUUID } from "crypto";

// ─── Configuration ──────────────────────────────────────────────────

const ATTIJARI_BASE = process.env.ATTIJARI_BASE_URL || "https://api.awsbx.dxp.delivery";
const ATTIJARI_CLIENT_ID = process.env.ATTIJARI_CLIENT_ID || "";
const ATTIJARI_CLIENT_SECRET = process.env.ATTIJARI_CLIENT_SECRET || "";
const ATTIJARI_MERCHANT_ID = process.env.ATTIJARI_MERCHANT_ID || "";

// ─── Types ──────────────────────────────────────────────────────────

export interface RIB {
  bank_code: string;
  branch_code: string;
  account_number: string;
  rib_key: string;
  rib_identifier: string;
  currency: string;
  holder_name: string;
  holder_address?: string;
}

export interface TransferRequest {
  amount_cents: number;
  currency: "MAD" | "USD";
  destination_rib: RIB;
  sender_account: string;
  reference: string;
  description?: string;
  end_to_end_id?: string;
}

export interface TransferResult {
  ok: boolean;
  transaction_id?: string;
  status?: string;
  error?: string;
  /** Bank transfer instructions for manual execution */
  instructions?: string;
  raw?: unknown;
}

export interface TransferStatus {
  transaction_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  amount_cents: number;
  currency: string;
  completed_at?: string;
  failure_reason?: string;
}

// ─── Auth Token Management ──────────────────────────────────────────

let cachedToken: { token: string; expires_at: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.token;
  }

  if (!ATTIJARI_CLIENT_ID || !ATTIJARI_CLIENT_SECRET) {
    throw new Error("ATTIJARI_CLIENT_ID and ATTIJARI_CLIENT_SECRET required");
  }

  const timestamp = Date.now().toString();
  const nonce = randomUUID();
  const signature = createHmac("sha256", ATTIJARI_CLIENT_SECRET)
    .update(`${ATTIJARI_CLIENT_ID}:${timestamp}:${nonce}`)
    .digest("hex");

  const res = await fetch(`${ATTIJARI_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Api-Key": ATTIJARI_CLIENT_ID,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": signature,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "payments transfers",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Attijari auth failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedToken.token;
}

// ─── Transfer Execution ─────────────────────────────────────────────

/**
 * Generate bank transfer instructions (manual execution).
 * Used as fallback when API is unavailable.
 */
function generateTransferInstructions(req: TransferRequest): string {
  return [
    `ATTIJARIWAFA BANK TRANSFER INSTRUCTION`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
    `Reference: ${req.reference}`,
    `End-to-End ID: ${req.end_to_end_id || "N/A"}`,
    ``,
    `FROM:`,
    `  Account: ${req.sender_account}`,
    `  Bank: Attijariwafa Bank`,
    ``,
    `TO:`,
    `  Name: ${req.destination_rib.holder_name}`,
    `  Account: ${req.destination_rib.account_number}`,
    `  Bank: ${req.destination_rib.bank_code} - ${req.destination_rib.branch_code}`,
    `  RIB: ${req.destination_rib.rib_identifier}`,
    ``,
    `AMOUNT: ${req.currency} ${(req.amount_cents / 100).toFixed(2)}`,
    `DESCRIPTION: ${req.description || req.reference}`,
    ``,
    `ACTION: Execute via Attijariwafa web banking or branch.`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");
}

/**
 * Initiate a bank transfer via Attijariwafa API.
 * Falls back to generating instructions if API is unavailable.
 */
export async function initiateTransfer(req: TransferRequest): Promise<TransferResult> {
  const endToEndId = req.end_to_end_id || `E2E-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;

  // Try API first
  try {
    const token = await getAccessToken();

    // Create payment consent
    const consentRes = await fetch(`${ATTIJARI_BASE}/v1/payments/consents`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-End-To-End-Id": endToEndId,
      },
      body: JSON.stringify({
        creditor_account: {
          scheme_name: "RIB",
          identification: req.destination_rib.rib_identifier,
          name: req.destination_rib.holder_name,
          currency: req.destination_rib.currency,
        },
        debtor_account: {
          identification: req.sender_account,
        },
        amount: {
          value: (req.amount_cents / 100).toFixed(2),
          currency: req.currency,
        },
        reference: req.reference,
        description: req.description || `Transfer ${req.reference}`,
        payment_type: "instant",
        execution_date: "immediate",
      }),
    });

    if (!consentRes.ok) {
      const err = await consentRes.text();
      // API failed — fall back to manual instructions
      return {
        ok: true,
        transaction_id: `MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
        status: "pending",
        instructions: generateTransferInstructions(req),
        raw: { api_error: `Consent failed (${consentRes.status}): ${err}`, fallback: "manual_instructions" },
      };
    }

    const consent = await consentRes.json();
    const consentId = consent.consent_id;

    // Authorise
    const authRes = await fetch(`${ATTIJARI_BASE}/v1/payments/consents/${consentId}/authorisations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-End-To-End-Id": endToEndId,
      },
      body: JSON.stringify({
        authentication_method: "merchant_initiated",
        merchant_id: ATTIJARI_MERCHANT_ID,
        signature: createHmac("sha256", ATTIJARI_CLIENT_SECRET)
          .update(`${consentId}:${req.amount_cents}:${req.currency}:${endToEndId}`)
          .digest("hex"),
      }),
    });

    if (!authRes.ok) {
      return {
        ok: true,
        transaction_id: `MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
        status: "pending",
        instructions: generateTransferInstructions(req),
        raw: { api_error: `Auth failed (${authRes.status})`, fallback: "manual_instructions" },
      };
    }

    // Confirm
    const confirmRes = await fetch(`${ATTIJARI_BASE}/v1/payments/${consentId}/confirm`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-End-To-End-Id": endToEndId,
      },
    });

    if (!confirmRes.ok) {
      return {
        ok: true,
        transaction_id: `MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
        status: "pending",
        instructions: generateTransferInstructions(req),
        raw: { api_error: `Confirm failed (${confirmRes.status})`, fallback: "manual_instructions" },
      };
    }

    const result = await confirmRes.json();
    return {
      ok: true,
      transaction_id: result.transaction_id || consentId,
      status: result.status || "processing",
      raw: { consent_id: consentId, end_to_end_id: endToEndId },
    };
  } catch (err) {
    // API unreachable — fall back to manual instructions
    return {
      ok: true,
      transaction_id: `MANUAL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
      status: "pending",
      instructions: generateTransferInstructions(req),
      raw: { api_error: err instanceof Error ? err.message : String(err), fallback: "manual_instructions" },
    };
  }
}

/**
 * Check transfer status
 */
export async function getTransferStatus(transactionId: string): Promise<TransferStatus> {
  if (transactionId.startsWith("MANUAL-")) {
    return {
      transaction_id: transactionId,
      status: "pending",
      amount_cents: 0,
      currency: "MAD",
    };
  }

  const token = await getAccessToken();
  const res = await fetch(`${ATTIJARI_BASE}/v1/payments/${transactionId}/status`, {
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Status check failed (${res.status})`);
  }

  return res.json();
}

/**
 * Poll transfer status until terminal state
 */
export async function waitForCompletion(
  transactionId: string,
  maxWaitMs: number = 30_000,
  pollIntervalMs: number = 2_000
): Promise<TransferStatus> {
  // Manual transfers won't change status via API
  if (transactionId.startsWith("MANUAL-")) {
    return {
      transaction_id: transactionId,
      status: "pending",
      amount_cents: 0,
      currency: "MAD",
    };
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = await getTransferStatus(transactionId);
    if (["completed", "failed", "cancelled"].includes(status.status)) {
      return status;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    transaction_id: transactionId,
    status: "pending",
    amount_cents: 0,
    currency: "MAD",
  };
}

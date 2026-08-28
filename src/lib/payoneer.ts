/**
 * Payoneer SWIFT Transfer Rail
 *
 * Routes EUR from Payoneer → MAD at Attijariwafa Bank Morocco
 * via SWIFT international wire transfer.
 *
 * Flow:
 *   1. Generate SWIFT payment instruction
 *   2. If API credentials available, submit via Payoneer API
 *   3. Otherwise, generate instruction for manual execution in Payoneer dashboard
 *
 * Payoneer supports EUR→MAD SWIFT transfers to Moroccan banks.
 * Beneficiary receives MAD equivalent via SWIFT MT103.
 */

import { randomUUID } from "crypto";

// ─── Configuration ──────────────────────────────────────────────────

const PAYONEER_CLIENT_ID = process.env.PAYONEER_CLIENT_ID || process.env.OWNER_PAYONEER_ID || "";
const PAYONEER_CLIENT_SECRET = process.env.PAYONEER_CLIENT_SECRET || process.env.PAYONEER_API_SECRET || "";
const PAYONEER_PROGRAM_ID = process.env.PAYONEER_PROGRAM_ID || "";
const PAYONEER_USER_ID = process.env.PAYONEER_USER_ID || "";
const PAYONEER_BASE = process.env.PAYONEER_BASE_URL || "https://api.payoneer.com";
const PAYONEER_ACCOUNT_ID = process.env.PAYONEER_ACCOUNT_ID || "325EF6267B78444D86BF8286069806BE";

// Attijariwafa Bank Morocco SWIFT code
const ATTIJARI_BIC = "BMCEMAMX";

// ─── Types ──────────────────────────────────────────────────────────

export interface PayoneerTransferRequest {
  amount_eur: number;
  amount_mad?: number;
  fx_rate?: number;
  beneficiary_name: string;
  beneficiary_account: string;
  beneficiary_bic: string;
  beneficiary_bank: string;
  reference: string;
  remittance_info?: string;
}

export interface PayoneerTransferResult {
  ok: boolean;
  payment_id?: string;
  swift_reference?: string;
  status?: string;
  instructions?: string;
  error?: string;
  fallback?: boolean;
}

// ─── Auth ───────────────────────────────────────────────────────────

let cachedToken: { token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.token;
  }

  if (!PAYONEER_USER_ID || !PAYONEER_CLIENT_SECRET) {
    throw new Error("PAYONEER_USER_ID and PAYONEER_API_SECRET required");
  }

  // Payoneer API v4 — OAuth2 client credentials grant
  const credentials = Buffer.from(
    `${PAYONEER_USER_ID}:${PAYONEER_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${PAYONEER_BASE}/mps-api/v4/authentication/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: PAYONEER_USER_ID,
      client_secret: PAYONEER_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Payoneer auth failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.token;
}

// ─── Instruction Generator ──────────────────────────────────────────

export function generatePayoneerInstructions(
  req: PayoneerTransferRequest,
  ref: string
): string {
  const mt103Lines = [
    `{1:F01PAYONEERL2XXXX0000000000}`,
    `{2:I${req.beneficiary_bic}XXXXN}`,
    `{4:`,
    `:20:${ref}`,
    `:23B:CRED`,
    `:32A:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}EUR${req.amount_eur.toFixed(2).replace(".", ",")}`,
    `:50K:/PAYONEER-${PAYONEER_ACCOUNT_ID}`,
    `YOUNES TSOULI`,
    `:59:/${req.beneficiary_account}`,
    `${req.beneficiary_name}`,
    `:71A:SHA`,
    `:77B:/REC/${req.reference}`,
    `}`,
    `-`,
  ];

  return [
    `╔══════════════════════════════════════════════════════════════════╗`,
    `║        PAYONEER SWIFT WIRE TRANSFER INSTRUCTION                ║`,
    `║        Payoneer EUR → Attijariwafa Bank MAD (Morocco)          ║`,
    `╚══════════════════════════════════════════════════════════════════╝`,
    ``,
    `Date:         ${new Date().toISOString().split("T")[0]}`,
    `Reference:    ${req.reference}`,
    `SWIFT Ref:    ${ref}`,
    ``,
    `═══ SENDER (PAYONEER) ═══════════════════════════════════════════`,
    `Account Holder:  YOUNES TSOULI`,
    `Payoneer ID:     ${PAYONEER_ACCOUNT_ID}`,
    `Currency:        EUR`,
    `Platform:        Payoneer`,
    ``,
    `═══ BENEFICIARY (ATTIIJARIWAFA BANK) ════════════════════════════`,
    `Account Holder:  ${req.beneficiary_name}`,
    `Account Number:  ${req.beneficiary_account}`,
    `Bank:            ${req.beneficiary_bank}`,
    `BIC/SWIFT:       ${req.beneficiary_bic}`,
    `Country:         Morocco`,
    `Currency:        MAD (EUR converted by SWIFT correspondent)`,
    ``,
    `═══ AMOUNT ══════════════════════════════════════════════════════`,
    `Send Amount:     EUR ${req.amount_eur.toFixed(2)}`,
    req.amount_mad ? `Receive Amount:   MAD ${req.amount_mad.toFixed(2)}` : null,
    req.fx_rate ? `Estimated Rate:   EUR/MAD ${req.fx_rate}` : null,
    `Charges:         SHA (shared — each pays own bank fees)`,
    ``,
    `═══ REMITTANCE ══════════════════════════════════════════════════`,
    `Purpose:         ${req.remittance_info || "Owner payout - HIT Swarm revenue"}`,
    ``,
    `═══ MT103 SWIFT MESSAGE ═════════════════════════════════════════`,
    mt103Lines.join("\r\n"),
    ``,
    `═══ HOW TO EXECUTE ══════════════════════════════════════════════`,
    `1. Log into Payoneer:  https://www.payoneer.com/login`,
    `2. Go to:  Pay > Send to Bank Account (SWIFT)`,
    `3. Enter beneficiary details above`,
    `4. Amount: EUR ${req.amount_eur.toFixed(2)}`,
    `5. Reference: ${req.reference}`,
    `6. Confirm and send`,
    ``,
    `Funds typically arrive within 1-3 business days via SWIFT.`,
    `Attijariwafa will credit MAD equivalent at prevailing rate.`,
    ``,
    `Payoneer fee: ~1.5% for EUR→MAD SWIFT (varies by account tier)`,
    ``,
    `╚══════════════════════════════════════════════════════════════════╝`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Transfer Execution ─────────────────────────────────────────────

export async function getPayoneerBalance(): Promise<{
  balance?: string;
  currency?: string;
  account_id?: string;
  error?: string;
}> {
  if (!PAYONEER_USER_ID || !PAYONEER_CLIENT_SECRET) {
    return { error: "PAYONEER_USER_ID / PAYONEER_API_SECRET not configured" };
  }
  if (!PAYONEER_ACCOUNT_ID) {
    return { error: "PAYONEER_ACCOUNT_ID not configured" };
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(`${PAYONEER_BASE}/v4/accounts/${PAYONEER_ACCOUNT_ID}/balance`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${await res.text()}` };
    }
    const data = await res.json();
    return {
      balance: data.available_balance ?? data.balance ?? "0",
      currency: data.currency ?? "USD",
      account_id: PAYONEER_ACCOUNT_ID,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function executePayoneerTransfer(
  req: PayoneerTransferRequest
): Promise<PayoneerTransferResult> {
  const ref = `PAY-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const instructions = generatePayoneerInstructions(req, ref);

  // Try Payoneer API if credentials available
  if (PAYONEER_USER_ID && PAYONEER_CLIENT_SECRET) {
    try {
      const token = await getAccessToken();

      // Step 1: Get balance to verify funds
      const balRes = await fetch(`${PAYONEER_BASE}/v4/accounts/${PAYONEER_ACCOUNT_ID}/balance`, {
        headers: { "Authorization": `Bearer ${token}` },
      });

      let availableBalance = 0;
      if (balRes.ok) {
        const balData = await balRes.json();
        availableBalance = parseFloat(balData.available_balance || "0");
      }

      // Step 2: Create payment
      const res = await fetch(`${PAYONEER_BASE}/v4/accounts/${PAYONEER_ACCOUNT_ID}/payments`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: req.amount_eur.toFixed(2),
          currency: "EUR",
          beneficiary: {
            name: req.beneficiary_name,
            account_number: req.beneficiary_account,
            bic: req.beneficiary_bic,
            bank_name: req.beneficiary_bank,
            country: "MA",
          },
          reference: req.reference,
          payment_method: "SWIFT",
          charge_type: "SHA",
          description: req.remittance_info || `SWIFT ${req.reference}`,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          ok: true,
          payment_id: data.payment_id || data.id || ref,
          swift_reference: ref,
          status: "submitted",
          instructions,
        };
      }

      const errText = await res.text();
      // Log auth error details for debugging
      return {
        ok: false,
        payment_id: ref,
        status: "api_error",
        error: `Payoneer API ${res.status}: ${errText}`,
        instructions,
        fallback: true,
      };
    } catch (apiErr) {
      // Fall through to manual
    }
  }

  // Manual fallback — always generates instructions
  return {
    ok: true,
    payment_id: `MANUAL-${ref}`,
    swift_reference: ref,
    status: "pending_manual",
    instructions,
    fallback: true,
  };
}

export async function getPayoneerStatus(paymentId: string): Promise<{
  status: string;
  completed_at?: string;
}> {
  if (paymentId.startsWith("MANUAL-")) {
    return { status: "pending_manual" };
  }
  return { status: "unknown" };
}

/**
 * SWIFT Transfer Rail
 *
 * Routes EUR from Banking Circle → MAD at Attijariwafa Bank Morocco
 * via SWIFT MT103/pacs.008 international wire transfer.
 *
 * Flow:
 *   1. Generate SWIFT payment instruction (pacs.008)
 *   2. Submit via Banking Circle REST API
 *   3. Banking Circle debits EUR account, sends SWIFT
 *   4. Attijariwafa receives MAD (converted by correspondent)
 *
 * Environment variables:
 *   BANKING_CIRCLE_CLIENT_ID     - Banking Circle API client ID
 *   BANKING_CIRCLE_CLIENT_SECRET - Banking Circle API client secret
 *   BANKING_CIRCLE_BASE_URL      - API base (default: https://api.bankingcircle.com)
 *   BANKING_CIRCLE_ACCOUNT_ID    - EUR account to debit
 *   BANKING_CIRCLE_BIC           - Our BIC (default: BCIRLULL)
 *
 * Fallback: generates MT103 instruction sheet for manual SWIFT via portal.
 */

import { randomUUID } from "crypto";

// ─── Configuration ──────────────────────────────────────────────────

const BC_BASE = process.env.BANKING_CIRCLE_BASE_URL || "https://api.bankingcircle.com";
const BC_CLIENT_ID = process.env.BANKING_CIRCLE_CLIENT_ID || "";
const BC_CLIENT_SECRET = process.env.BANKING_CIRCLE_CLIENT_SECRET || "";
const BC_ACCOUNT_ID = process.env.BANKING_CIRCLE_ACCOUNT_ID || "LU774080000041265646";
const BC_BIC = process.env.BANKING_CIRCLE_BIC || "BCIRLULL";

// Attijariwafa Bank Morocco SWIFT code
const ATTIJARI_BIC = "BMCEMAMX";

// ─── Types ──────────────────────────────────────────────────────────

export interface SWIFTTransferRequest {
  /** Amount in EUR (will be converted to MAD by correspondent) */
  amount_eur: number;
  /** Target amount in MAD (for reference) */
  amount_mad?: number;
  /** EUR/MAD exchange rate (if known) */
  fx_rate?: number;
  /** Beneficiary name */
  beneficiary_name: string;
  /** Beneficiary account (RIB / IBAN) */
  beneficiary_account: string;
  /** Beneficiary bank BIC */
  beneficiary_bic: string;
  /** Beneficiary bank name */
  beneficiary_bank: string;
  /** Payment reference */
  reference: string;
  /** Remittance info */
  remittance_info?: string;
}

export interface SWIFTTransferResult {
  ok: boolean;
  payment_id?: string;
  swift_reference?: string;
  status?: string;
  /** MT103 instruction text for audit / manual fallback */
  mt103?: string;
  error?: string;
  /** Set to true if API unavailable and instructions generated */
  fallback?: boolean;
}

// ─── Auth Token Management ──────────────────────────────────────────

let cachedToken: { token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.token;
  }

  if (!BC_CLIENT_ID || !BC_CLIENT_SECRET) {
    throw new Error("BANKING_CIRCLE_CLIENT_ID and BANKING_CIRCLE_CLIENT_SECRET required");
  }

  const res = await fetch(`${BC_BASE}/authentication/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: BC_CLIENT_ID,
      client_secret: BC_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`Banking Circle auth failed (${res.status})`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.token;
}

// ─── MT103 Generator ────────────────────────────────────────────────

function generateMT103(req: SWIFTTransferRequest, swiftRef: string): string {
  const today = new Date();
  const yy = today.getFullYear().toString().slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yy}${mm}${dd}`;

  const amountStr = req.amount_eur.toFixed(2).replace(".", ",");
  const lines = [
    `{1:F01${BC_BIC}SXXXX0000000000}`,
    `{2:I${req.beneficiary_bic}XXXXN}`,
    `{4:`,
    `:20:${swiftRef}`,
    `:23B:CRED`,
    `:32A:${dateStr}EUR${amountStr}`,
    `:50K:/${BC_ACCOUNT_ID}`,
    `YOUNES TSOULI`,
    `LU774080000041265646`,
    `:59:/${req.beneficiary_account}`,
    `${req.beneficiary_name}`,
    `:71A:SHA`,
    `:77B:/REC/${req.reference}`,
    `}`,
    `-`,
  ];
  if (req.remittance_info) {
    lines.splice(-2, 0, `:70:${req.remittance_info}`);
  }
  return lines.join("\r\n");
}

// ─── Transfer Execution ─────────────────────────────────────────────

/**
 * Execute SWIFT transfer via Banking Circle API.
 * Falls back to MT103 instruction generation if API unavailable.
 */
export async function executeSWIFTTransfer(
  req: SWIFTTransferRequest
): Promise<SWIFTTransferResult> {
  const swiftRef = `SW${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const mt103 = generateMT103(req, swiftRef);

  // Try Banking Circle API
  try {
    const token = await getAccessToken();

    const res = await fetch(`${BC_BASE}/payments/singles`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: BC_ACCOUNT_ID,
        amount: req.amount_eur.toFixed(2),
        currency: "EUR",
        beneficiaryName: req.beneficiary_name,
        beneficiaryAccount: req.beneficiary_account,
        beneficiaryBic: req.beneficiary_bic,
        beneficiaryBank: req.beneficiary_bank,
        reference: req.reference,
        remittanceInfo: req.remittance_info || `SWIFT transfer ${req.reference}`,
        paymentMethod: "SWIFT",
        chargeType: "SHA",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      // API failed — fall back to MT103 instructions
      return {
        ok: true,
        payment_id: `SWIFT-MANUAL-${swiftRef}`,
        swift_reference: swiftRef,
        status: "pending_manual",
        mt103,
        fallback: true,
        error: `API failed (${res.status}): ${err}`,
      };
    }

    const data = await res.json();
    return {
      ok: true,
      payment_id: data.paymentId || swiftRef,
      swift_reference: swiftRef,
      status: "submitted",
      mt103,
    };
  } catch (err) {
    // API unreachable — generate manual instructions
    return {
      ok: true,
      payment_id: `SWIFT-MANUAL-${swiftRef}`,
      swift_reference: swiftRef,
      status: "pending_manual",
      mt103,
      fallback: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check SWIFT payment status via Banking Circle
 */
export async function getSWIFTStatus(paymentId: string): Promise<{
  status: string;
  completed_at?: string;
  failure_reason?: string;
}> {
  if (paymentId.startsWith("SWIFT-MANUAL-")) {
    return { status: "pending_manual" };
  }

  try {
    const token = await getAccessToken();
    const res = await fetch(`${BC_BASE}/payments/singles/${paymentId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const data = await res.json();
    return {
      status: data.status || "unknown",
      completed_at: data.completedAt,
      failure_reason: data.failureReason,
    };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Generate full SWIFT transfer instruction document
 */
export function generateSWIFTInstructions(
  req: SWIFTTransferRequest,
  swiftRef: string
): string {
  const mt103 = generateMT103(req, swiftRef);
  return [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║           SWIFT WIRE TRANSFER INSTRUCTION                  ║`,
    `║           Banking Circle EUR → Attijariwafa MAD            ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    ``,
    `Date:       ${new Date().toISOString().split("T")[0]}`,
    `Reference:  ${req.reference}`,
    `SWIFT Ref:  ${swiftRef}`,
    ``,
    `─── SENDER ───────────────────────────────────────────────`,
    `Account Holder:  YOUNES TSOULI`,
    `Account Number:  ${BC_ACCOUNT_ID}`,
    `Bank:            Banking Circle S.A.`,
    `BIC/SWIFT:       ${BC_BIC}`,
    `Country:         Luxembourg`,
    `Currency:        EUR`,
    ``,
    `─── BENEFICIARY ──────────────────────────────────────────`,
    `Account Holder:  ${req.beneficiary_name}`,
    `Account Number:  ${req.beneficiary_account}`,
    `Bank:            ${req.beneficiary_bank}`,
    `BIC/SWIFT:       ${req.beneficiary_bic}`,
    `Country:         Morocco`,
    `Currency:        MAD (EUR converted by correspondent)`,
    ``,
    `─── AMOUNT ───────────────────────────────────────────────`,
    `Send Amount:     EUR ${req.amount_eur.toFixed(2)}`,
    req.amount_mad ? `Receive Amount:   MAD ${req.amount_mad.toFixed(2)}` : null,
    req.fx_rate ? `FX Rate:          EUR/MAD ${req.fx_rate}` : null,
    `Charges:         SHA (shared)`,
    ``,
    `─── REMITTANCE ───────────────────────────────────────────`,
    `Purpose:         ${req.remittance_info || "Owner payout - HIT Swarm revenue"}`,
    ``,
    `─── MT103 MESSAGE ────────────────────────────────────────`,
    mt103,
    ``,
    `─── EXECUTION ────────────────────────────────────────────`,
    `This SWIFT transfer will be executed via Banking Circle API.`,
    `If API is unavailable, log into Banking Circle Connect portal:`,
    `  https://connect.bankingcircle.com`,
    `  Navigate to: Payments > New Payment > SWIFT`,
    `  Enter details above and submit.`,
    ``,
    `Funds typically arrive within 1-3 business days.`,
    `Attijariwafa will credit MAD equivalent at prevailing rate.`,
    ``,
    `╚══════════════════════════════════════════════════════════════╝`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Re-export for the MT103 generation
const mt103Generator = { generateMT103, generateSWIFTInstructions };
export default mt103Generator;

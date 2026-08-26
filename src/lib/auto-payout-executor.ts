/**
 * Auto-Payout Executor — Owner hands-free settlement
 *
 * Routes payments to the best available rail by currency:
 *   GBP → Wise API (domestic credit to owner's Wise GBP account)
 *   USD → Dwolla ACH (US domestic) → Wise SWIFT → Attijari MAD
 *   EUR → Wise SWIFT → Attijari MAD (or Currencycloud if configured)
 *   MAD → Wise SWIFT to Attijariwafa MAD
 *
 * Priority: real API > manual fallback. If no API credentials, returns
 * pending_manual with instructions (never silently drops money).
 *
 * Env vars (Vercel):
 *   WISE_API_TOKEN        - Real Wise API token
 *   WISE_PROFILE_ID       - Wise profile ID
 *   WISE_SOURCE_ACCOUNT   - Our IBAN (default: GB70TRWI60846495805703)
 *   DWOLLA_KEY            - Dwolla application key
 *   DWOLLA_SECRET         - Dwolla application secret
 *   CURRENCYCLOUD_API_KEY - Currencycloud API key
 *   CURRENCYCLOUD_LOGIN_ID - Currencycloud login ID
 *   CHARIPAY_API_KEY      - ChariBaaS API key (optional, for MAD direct)
 */

import {
  WISE_CONFIGURED,
  sendGBPDomesticCredit,
  sendSWIFTTransfer,
  type WiseTransferResult,
} from "@/lib/wise-api";
import {
  DWOLLA_CONFIGURED,
  createTransfer as dwollaTransfer,
  type DwollaTransferResult,
} from "@/lib/rails/dwolla";
import {
  CURRENCYCLOUD_CONFIGURED,
  createConversion,
  createPayment,
  getRate,
  type CCPaymentResult,
} from "@/lib/rails/currencycloud";
import { randomUUID } from "crypto";

// ─── Owner Accounts ─────────────────────────────────────────────────

const OWNER_ACCOUNTS = {
  attijari_1: {
    iban: process.env.ATTIJARI_ACCOUNT_1 || "007810000448200061321372",
    name: "YOUNES TSOULI",
    bic: "BMCEMAMX",
    bank: "Attijariwafa Bank",
    country: "MA",
    currency: "MAD",
  },
  attijari_2: {
    iban: process.env.ATTIJARI_ACCOUNT_2 || "007810000448500030594182",
    name: "YOUNES TSOULI",
    bic: "BMCEMAMX",
    bank: "Attijariwafa Bank",
    country: "MA",
    currency: "MAD",
  },
  wise_gbp: {
    iban: "GB70TRWI60846495805703",
    name: "Younes Tsouli",
    bic: "TRWIGB2LXXX",
    bank: "Wise Payments Limited",
    country: "GB",
    currency: "GBP",
  },
  banking_circle: {
    iban: "LU774080000041265646",
    name: "YOUNES TSOULI",
    bic: "BCIRLULL",
    bank: "Banking Circle S.A.",
    country: "LU",
    currency: "EUR",
  },
};

// ─── Types ──────────────────────────────────────────────────────────

export interface PayoutRequest {
  amount: number;
  currency: string;
  reference: string;
  description?: string;
  target_account?: string;
}

export interface PayoutResult {
  ok: boolean;
  rail: string;
  transfer_id?: string;
  status: string;
  amount: number;
  currency: string;
  rate?: number;
  fee?: number;
  target: string;
  error?: string;
  instructions?: string;
}

// ─── FX Rates ───────────────────────────────────────────────────────

const EUR_MAD_RATE = 10.7;
const EUR_GBP_RATE = 0.86;
const USD_EUR_RATE = 0.92;

// ─── Main Executor ──────────────────────────────────────────────────

export async function executePayout(req: PayoutRequest): Promise<PayoutResult> {
  const { amount, currency, reference, description } = req;
  const target = OWNER_ACCOUNTS.attijari_1;

  if (amount <= 0) {
    return {
      ok: false,
      rail: "none",
      status: "invalid_amount",
      amount,
      currency,
      target: "none",
      error: "Amount must be positive",
    };
  }

  // ── Route 1: GBP → Wise domestic credit ──
  if (currency === "GBP" && WISE_CONFIGURED) {
    const result = await sendGBPDomesticCredit(
      amount,
      OWNER_ACCOUNTS.wise_gbp.iban,
      OWNER_ACCOUNTS.wise_gbp.bic,
      OWNER_ACCOUNTS.wise_gbp.name,
      reference
    );

    if (result.ok) {
      return {
        ok: true,
        rail: "wise_gbp_domestic",
        transfer_id: result.transfer_id,
        status: result.status || "processing",
        amount,
        currency: "GBP",
        rate: result.rate,
        fee: result.fee,
        target: "Wise GBP Account",
      };
    }

    return {
      ok: false,
      rail: "wise_gbp_domestic",
      status: "failed",
      amount,
      currency: "GBP",
      target: "Wise GBP Account",
      error: result.error,
      instructions: `Manual Wise credit: £${amount.toFixed(2)} to ${OWNER_ACCOUNTS.wise_gbp.iban}`,
    };
  }

  // ── Route 2: USD → Dwolla ACH (US domestic) or Wise SWIFT → Attijari MAD ──
  if (currency === "USD") {
    const eurAmount = Math.round(amount * USD_EUR_RATE * 100) / 100;
    const madAmount = Math.round(eurAmount * EUR_MAD_RATE * 100) / 100;

    // Priority 1: Dwolla ACH for US domestic transfers
    if (DWOLLA_CONFIGURED && process.env.DWOLLA_MASTER_FUNDING_SOURCE) {
      try {
        const dwollaResult = await dwollaTransfer({
          source: process.env.DWOLLA_MASTER_FUNDING_SOURCE,
          destination: process.env.DWOLLA_DESTINATION_FUNDING_SOURCE || process.env.DWOLLA_MASTER_FUNDING_SOURCE,
          amount: amount.toFixed(2),
          currency: "USD",
          correlationId: reference,
          metadata: { purpose: description || `Owner payout ${reference}` },
        });

        if (dwollaResult.ok) {
          return {
            ok: true,
            rail: "dwolla_ach",
            transfer_id: dwollaResult.transfer_id,
            status: dwollaResult.status || "processing",
            amount,
            currency: "USD",
            target: "US Bank via Dwolla ACH",
            instructions: `USD $${amount.toFixed(2)} sent via Dwolla ACH. Will convert to MAD on arrival.`,
          };
        }
      } catch {
        // Fall through to Wise SWIFT
      }
    }

    // Priority 2: Wise SWIFT conversion
    if (WISE_CONFIGURED) {
      const result = await sendSWIFTTransfer(
        "EUR",
        "MAD",
        eurAmount,
        target.iban,
        target.bic,
        target.name,
        target.country,
        reference,
        description || `USD $${amount.toFixed(2)} → EUR ${eurAmount.toFixed(2)} → MAD ${madAmount.toFixed(2)}`
      );

      if (result.ok) {
        return {
          ok: true,
          rail: "wise_swift",
          transfer_id: result.transfer_id,
          status: result.status || "processing",
          amount: madAmount,
          currency: "MAD",
          rate: result.rate,
          fee: result.fee,
          target: "Attijariwafa MAD (via Wise SWIFT)",
        };
      }
    }

    return {
      ok: true,
      rail: "pending_manual_swift",
      status: "pending_manual",
      amount: madAmount,
      currency: "MAD",
      target: "Attijariwafa MAD",
      instructions: generateSWIFTInstructions("EUR", eurAmount, madAmount, reference, target),
    };
  }

  // ── Route 3: EUR → SWIFT to Attijariwafa MAD (Wise or Currencycloud) ──
  if (currency === "EUR") {
    const madAmount = Math.round(amount * EUR_MAD_RATE * 100) / 100;

    // Priority 1: Wise SWIFT
    if (WISE_CONFIGURED) {
      const result = await sendSWIFTTransfer(
        "EUR",
        "MAD",
        amount,
        target.iban,
        target.bic,
        target.name,
        target.country,
        reference,
        description || `EUR ${amount.toFixed(2)} → MAD ${madAmount.toFixed(2)}`
      );

      if (result.ok) {
        return {
          ok: true,
          rail: "wise_swift",
          transfer_id: result.transfer_id,
          status: result.status || "processing",
          amount: madAmount,
          currency: "MAD",
          rate: result.rate,
          fee: result.fee,
          target: "Attijariwafa MAD (via Wise SWIFT)",
        };
      }
    }

    // Priority 2: Currencycloud cross-border
    if (CURRENCYCLOUD_CONFIGURED) {
      try {
        const ccResult = await createPayment({
          beneficiary_name: target.name,
          beneficiary_country: target.country,
          beneficiary_bank_name: target.bank,
          beneficiary_iban: target.iban,
          beneficiary_swift_bic: target.bic,
          amount: amount.toFixed(2),
          currency: "EUR",
          reference,
        });

        if (ccResult.ok) {
          return {
            ok: true,
            rail: "currencycloud",
            transfer_id: ccResult.payment_id,
            status: ccResult.status || "processing",
            amount: madAmount,
            currency: "MAD",
            target: "Attijariwafa MAD (via Currencycloud)",
          };
        }
      } catch {
        // Fall through to manual
      }
    }

    return {
      ok: true,
      rail: "pending_manual_swift",
      status: "pending_manual",
      amount: madAmount,
      currency: "MAD",
      target: "Attijariwafa MAD",
      instructions: generateSWIFTInstructions("EUR", amount, madAmount, reference, target),
    };
  }

  // ── Route 4: MAD → direct SWIFT from Wise ──
  if (currency === "MAD" || !currency) {
    if (WISE_CONFIGURED) {
      const eurAmount = Math.round((amount / EUR_MAD_RATE) * 100) / 100;

      const result = await sendSWIFTTransfer(
        "EUR",
        "MAD",
        eurAmount,
        target.iban,
        target.bic,
        target.name,
        target.country,
        reference,
        description || `MAD ${amount.toFixed(2)} direct`
      );

      if (result.ok) {
        return {
          ok: true,
          rail: "wise_swift",
          transfer_id: result.transfer_id,
          status: result.status || "processing",
          amount,
          currency: "MAD",
          rate: result.rate,
          fee: result.fee,
          target: "Attijariwafa MAD (via Wise SWIFT)",
        };
      }
    }

    return {
      ok: true,
      rail: "pending_manual_swift",
      status: "pending_manual",
      amount,
      currency: "MAD",
      target: "Attijariwafa MAD",
      instructions: generateSWIFTInstructions("EUR", amount / EUR_MAD_RATE, amount, reference, target),
    };
  }

  return {
    ok: false,
    rail: "none",
    status: "unsupported_currency",
    amount,
    currency,
    target: "none",
    error: `Unsupported currency: ${currency}`,
  };
}

// ─── SWIFT Instructions Generator ───────────────────────────────────

function generateSWIFTInstructions(
  sourceCurrency: string,
  sourceAmount: number,
  targetAmount: number,
  reference: string,
  target: typeof OWNER_ACCOUNTS.attijari_1
): string {
  const id = randomUUID().slice(0, 8).toUpperCase();
  return [
    `╔══════════════════════════════════════════════════════════════════╗`,
    `║     AUTOMATED SWIFT PAYMENT INSTRUCTION                        ║`,
    `║     ${sourceCurrency} → MAD via SWIFT                              ║`,
    `╚══════════════════════════════════════════════════════════════════╝`,
    ``,
    `Reference:  ${reference}`,
    `SWIFT Ref:  SW${id}`,
    `Date:       ${new Date().toISOString().split("T")[0]}`,
    ``,
    `═══ AMOUNT ══════════════════════════════════════════════════════`,
    `Send:       ${sourceCurrency} ${sourceAmount.toFixed(2)}`,
    `Receive:    MAD ${targetAmount.toFixed(2)}`,
    `Rate:       1 ${sourceCurrency} ≈ ${(targetAmount / sourceAmount).toFixed(2)} MAD`,
    `Charges:    SHA (shared)`,
    ``,
    `═══ BENEFICIARY ═════════════════════════════════════════════════`,
    `Name:       ${target.name}`,
    `Account:    ${target.iban}`,
    `Bank:       ${target.bank}`,
    `BIC/SWIFT:  ${target.bic}`,
    `Country:    Morocco`,
    `Currency:   MAD`,
    ``,
    `╔══════════════════════════════════════════════════════════════════╗`,
    `║  SET WISE_API_TOKEN + WISE_PROFILE_ID to auto-execute!         ║`,
    `╚══════════════════════════════════════════════════════════════════╝`,
  ].join("\n");
}

// ─── Batch Executor ─────────────────────────────────────────────────

export async function executeBatchPayouts(
  payouts: PayoutRequest[]
): Promise<{ total: number; succeeded: number; failed: number; results: PayoutResult[] }> {
  const results: PayoutResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const payout of payouts) {
    const result = await executePayout(payout);
    results.push(result);

    if (result.ok) {
      succeeded++;
    } else {
      failed++;
    }

    // Rate limit: 200ms between API calls
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    total: payouts.length,
    succeeded,
    failed,
    results,
  };
}

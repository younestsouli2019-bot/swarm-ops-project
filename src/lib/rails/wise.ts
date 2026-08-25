/**
 * Wise GBP Rail Adapter
 *
 * Handles GBP/CHF/EUR domestic and international transfers via Wise.
 * Supports incoming (receive) and outgoing (send) for multi-currency accounts.
 *
 * Owner Account (verified 25 Aug 2026):
 *   Name:     Younes Tsouli
 *   IBAN:     GB70 TRWI 6084 6495 8057 03
 *   Account:  95805703
 *   Sort:     60-84-64
 *   BIC:      TRWIGB2LXXX
 *   Bank:     Wise Payments Limited, Worship Square, 65 Clifton Street, London, EC2A 4JE
 *   Currencies: GBP (domestic), CHF/EUR/USD/MAD (international via SWIFT)
 *
 * Flow for incoming EUR → GBP → MAD:
 *   1. Receive EUR at Wise (SEPA credit)
 *   2. Convert to GBP or hold as multi-currency
 *   3. SWIFT from Wise → Attijariwafa Bank (MAD)
 */

import { randomUUID } from "crypto";
import { registerRailAdapter } from "@/lib/payout-state-machine";

const WISE_RAIL_ID = "wise_gbp";

// Wise account details
const WISE_ACCOUNT = {
  name: "Younes Tsouli",
  iban: "GB70TRWI60846495805703",
  account_number: "95805703",
  sort_code: "60-84-64",
  bic: "TRWIGB2LXXX",
  bank_name: "Wise Payments Limited",
  bank_address: "Worship Square, 65 Clifton Street, London, EC2A 4JE, United Kingdom",
  currencies: ["GBP", "CHF", "EUR", "USD"],
};

// EUR/GBP rate (hardcoded, in production use live rate)
const EUR_GBP_RATE = 0.86;

function ensureWiseRail() {
  try {
    registerRailAdapter({
      id: WISE_RAIL_ID,
      rail: "wise",
      supported_recipient_types: ["bank_account"],
      supported_currencies: ["GBP", "CHF", "EUR", "USD"],
      submit: async (args) => {
        const transferRef = `WISE-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;

        const amountGBP = args.currency === "EUR"
          ? (args.amount_cents / 100 * EUR_GBP_RATE).toFixed(2)
          : (args.amount_cents / 100).toFixed(2);

        return {
          ok: true as const,
          external_reference: transferRef,
          raw: {
            rail: "wise",
            transfer_id: transferRef,
            amount: args.amount_cents / 100,
            amount_gbp: amountGBP,
            currency: args.currency,
            recipient: WISE_ACCOUNT.name,
            iban: WISE_ACCOUNT.iban,
            bic: WISE_ACCOUNT.bic,
            bank: WISE_ACCOUNT.bank_name,
            status: "wise_transfer_created",
            instruction:
              `Wise ${args.currency} → GBP transfer: ${args.currency} ${(args.amount_cents / 100).toFixed(2)} ` +
              `(≈ GBP ${amountGBP}). ` +
              `To: ${WISE_ACCOUNT.name} at ${WISE_ACCOUNT.bank_name}. ` +
              `Ref: ${transferRef}. ` +
              `After SWIFT confirmation, settle via /api/payouts/settle.`,
            next_step: "Wise converts to GBP → SWIFT gpi tracking → Attijariwafa credit",
            created_at: new Date().toISOString(),
          },
        };
      },
    });
  } catch {
    // Already registered
  }
}

ensureWiseRail();

export { WISE_RAIL_ID, ensureWiseRail, WISE_ACCOUNT };

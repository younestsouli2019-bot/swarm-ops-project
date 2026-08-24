/**
 * Attijariwafa Bank Rail Adapter
 *
 * Handles MAD (Moroccan Dirham) local and international transfers
 * via Attijariwafa Bank. For local transfers, creates a transfer
 * instruction with manual bank confirmation required.
 */

import { randomUUID } from "crypto";
import { registerRailAdapter } from "@/lib/payout-state-machine";

const ATTIJARI_RAIL_ID = "attijariwafa_mad";

// Register the Attijari rail adapter on module load
// (runs once per serverless cold start)
function ensureAttijariRail() {
  try {
    registerRailAdapter({
      id: ATTIJARI_RAIL_ID,
      rail: "attijariwafa_bank",
      supported_recipient_types: ["bank_account"],
      supported_currencies: ["USD", "MAD"],
      submit: async (args) => {
        // For Attijari bank transfers, we generate a transfer instruction
        // that requires manual bank confirmation (web banking or branch visit).
        //
        // In production, this would call Attijariwafa's Open Banking API
        // or STET/ONELOOK payment gateway. For now, we create the instruction
        // and await manual confirmation.

        const transferRef = `ATTIJI-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;

        // The transfer is "submitted" to the bank instruction queue.
        // Confirmation comes via /api/payouts/settle with bank statement proof.
        return {
          ok: true as const,
          external_reference: transferRef,
          raw: {
            rail: "attijariwafa_bank",
            transfer_id: transferRef,
            amount: args.amount_cents / 100,
            currency: args.currency,
            recipient_account: args.recipient_id,
            status: "instruction_created",
            instruction:
              `Transfer ${args.currency} ${(args.amount_cents / 100).toFixed(2)} ` +
              `to Attijariwafa Bank account ${args.recipient_id}. ` +
              `Reference: ${transferRef}. ` +
              `After bank confirms, settle via /api/payouts/settle.`,
            created_at: new Date().toISOString(),
          },
        };
      },
    });
  } catch {
    // Already registered (warm start)
  }
}

// Ensure adapter is registered on import
ensureAttijariRail();

export { ATTIJARI_RAIL_ID, ensureAttijariRail };

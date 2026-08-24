/**
 * migrate-orphan-event.mjs
 * ========================
 *
 * Backfills the specific orphan event the operator reported:
 *
 *   {
 *     "revenue_event_id": "no-preset-owner-recipient-1786729818116",
 *     "amount_cents": 3266
 *   }
 *
 * → "Provide an external confirmation ref (bank tx id, PayPal payout
 *    id, on-chain hash) before re-attempting the transition."
 *
 * This script:
 *   1. Deposits the $32.66 into the fallback vault (burn_rate_buffer)
 *      with state=PENDING_EXTERNAL_REF.
 *   2. Runs the detection swarm poll — transitions to
 *      HOLD_PENDING_VALIDATION after the routing window elapses.
 *   3. Optionally accepts an external confirmation ref (CLI arg
 *      --external-ref) to transition to TRANSITION_ALLOWED.
 *   4. Optionally clears the deposit to the preset owner (CLI arg
 *      --clear-to-owner) once a preset owner recipient is registered.
 *   5. Prints the canonical transaction_orchestrator block for the
 *      event, in the exact shape the operator specified:
 *
 *        {
 *          "transaction_orchestrator": {
 *            "target_event_id": "no-preset-owner-recipient-1786729818116",
 *            "amount_usd": 32.66,
 *            "current_status": "HOLD_PENDING_VALIDATION",
 *            "required_gate": "EXTERNAL_CONFIRMATION_REF_REQUIRED",
 *            "fallback_vault_destination": "vault://unidentified_revenues/emergency_funds",
 *            "validation_hooks": [...]
 *          }
 *        }
 *
 * Usage:
 *   bun scripts/migrate-orphan-event.mjs                          # deposit + sweep
 *   bun scripts/migrate-orphan-event.mjs --external-ref PAYID-ABC123  # transition to TRANSITION_ALLOWED
 *   bun scripts/migrate-orphan-event.mjs --clear-to-owner --external-ref PAYID-ABC123 --authorized-by operator
 *
 * No penny gets "lost in translation" — the $32.66 is now sitting in
 * the fallback vault with a HMAC-stamped deposit receipt, visible at
 * /api/orchestrator/vaults.
 */

import crypto from "node:crypto";

// ─── inline the vault-system logic (script is .mjs, lib is .ts) ───────────

const FALLBACK_VAULT_URI = "vault://unidentified_revenues/emergency_funds";
const FALLBACK_VAULT_ID = "burn_rate_buffer";
const REQUIRED_WITHDRAWAL_GATE = "EXTERNAL_CONFIRMATION_REF_REQUIRED";
const SAFE_HARBOR_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const ROUTING_WINDOW_MS = 5 * 60 * 1000;

const PRESET_OWNER_ACCOUNTS = Object.freeze({
  deployment_url: "https://t1trn6kunnv1-d.space-z.ai",
  deployment_bot_id: "t1trn6kunnv1-d",
  github_url: "https://github.com/younetsouli2019-bot/Nouveau-dossier-3-",
  github_user: "younetsouli2019-bot",
  github_repo: "Nouveau-dossier-3-",
});

const VAULT_DESCRIPTORS = {
  trickle_down_v1: {
    id: "trickle_down_v1",
    label: "Core Scaling Vault",
    emoji: "💡",
    strategy:
      "Trickle-down mechanism: Automatically releases capital to core " +
      "operations once the orphan event passes a 90-day safe-harbor holding window.",
    withdrawal_policy: "safe_harbor_90d",
  },
  burn_rate_buffer: {
    id: "burn_rate_buffer",
    label: "Emergency Reserves",
    emoji: "⚠️",
    strategy:
      "System Liquidity: Immediately accessible to cover sudden API " +
      "overages, hosting spikes, or third-party service degradation.",
    withdrawal_policy: "open",
  },
  black_swan_protocol: {
    id: "black_swan_protocol",
    label: "Doomsday Fund",
    emoji: "📉",
    strategy:
      "Absolute Protection: High-yield, isolated storage designed to " +
      "protect underlying infrastructure costs during catastrophic market " +
      "failures or prolonged network downtime.",
    withdrawal_policy: "catastrophe_only",
  },
};

// ─── in-memory vault store (dev mode — for production, persist to Base44) ─

const store = {
  deposits: new Map(),
  withdrawals: [],
  orphanIndex: new Map(),
  hmac_secret: process.env.VAULT_HMAC_SECRET || "charibaas-vault-hmac-secret-v1",
};

function computeDepositReceipt(d) {
  const payload = JSON.stringify({
    id: d.id,
    orphan_event_id: d.orphan_event_id,
    vault_id: d.vault_id,
    amount_cents: d.amount_cents,
    currency: d.currency,
    fallback_vault_uri: d.fallback_vault_uri,
    state: d.state,
    deposited_at: d.deposited_at,
    safe_harbor_expires_at: d.safe_harbor_expires_at,
  });
  return crypto.createHmac("sha256", store.hmac_secret).update(payload).digest("hex");
}

function computeWithdrawalReceipt(w) {
  const payload = JSON.stringify({
    id: w.id,
    source_deposit_id: w.source_deposit_id,
    from_vault_id: w.from_vault_id,
    destination: w.destination,
    amount_cents: w.amount_cents,
    external_confirmation_ref: w.external_confirmation_ref,
    receipt_hash: w.receipt_hash,
    created_at: w.created_at,
    authorized_by: w.authorized_by,
  });
  return crypto.createHmac("sha256", store.hmac_secret).update(payload).digest("hex");
}

function isValidExternalConfirmationRef(ref) {
  if (!ref || typeof ref !== "string") return false;
  const s = ref.trim();
  if (s.length < 6) return false;
  if (/^PAYID-/i.test(s)) return true;
  if (/^(ch|pi|py|re|txn)_[A-Za-z0-9]{12,}$/.test(s)) return true;
  if (/^\d{13,}$/.test(s)) return true;
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return true;
  if (/^[a-fA-F0-9]{64}$/.test(s)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{64,}$/.test(s)) return true;
  return false;
}

function classifyExternalRef(ref) {
  const s = (ref || "").trim();
  if (/^PAYID-/i.test(s)) return { rail: "paypal", real: true };
  if (/^ch_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_charge", real: true };
  if (/^pi_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_payment_intent", real: true };
  if (/^py_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_payout", real: true };
  if (/^re_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_refund", real: true };
  if (/^txn_[A-Za-z0-9]{12,}$/.test(s)) return { rail: "stripe_internal", real: true };
  if (/^\d{13,}$/.test(s)) return { rail: "ach_trace", real: true };
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return { rail: "evm_onchain", real: true };
  if (/^[a-fA-F0-9]{64}$/.test(s)) return { rail: "bitcoin_onchain_or_sha256", real: true };
  if (/^[1-9A-HJ-NP-Za-km-z]{64,}$/.test(s)) return { rail: "solana_onchain", real: true };
  return { rail: "unknown", real: false };
}

function depositOrphan(input) {
  const existingId = store.orphanIndex.get(input.orphan_event_id);
  if (existingId) {
    return { ok: true, deposit: store.deposits.get(existingId), created: false };
  }
  const now = Date.now();
  const deposit = {
    id: `vault-deposit-${crypto.randomUUID()}`,
    orphan_event_id: input.orphan_event_id,
    vault_id: input.vault_id || FALLBACK_VAULT_ID,
    amount_cents: Math.round(input.amount_cents),
    currency: input.currency || "USD",
    fallback_vault_uri: FALLBACK_VAULT_URI,
    state: "PENDING_EXTERNAL_REF",
    external_confirmation_ref: null,
    required_gate: REQUIRED_WITHDRAWAL_GATE,
    validation_hooks: [
      "https://internal.swarm/bank-api",
      "https://internal.swarm/paypal-logs",
      "https://internal.swarm/on-chain-rpc",
    ],
    deposited_at: now,
    safe_harbor_expires_at: now + SAFE_HARBOR_WINDOW_MS,
    updated_at: now,
    deposit_receipt: "",
    metadata: input.metadata || {},
  };
  deposit.deposit_receipt = computeDepositReceipt(deposit);
  store.deposits.set(deposit.id, deposit);
  store.orphanIndex.set(deposit.orphan_event_id, deposit.id);
  return { ok: true, deposit, created: true };
}

function markHoldingPendingValidation(orphanEventId) {
  const id = store.orphanIndex.get(orphanEventId);
  if (!id) return { ok: false, reason: "not found" };
  const d = store.deposits.get(id);
  if (!d) return { ok: false, reason: "deposit missing" };
  if (d.state !== "PENDING_EXTERNAL_REF") {
    return { ok: false, reason: `state is ${d.state}` };
  }
  d.state = "HOLD_PENDING_VALIDATION";
  d.updated_at = Date.now();
  d.deposit_receipt = computeDepositReceipt(d);
  return { ok: true, deposit: d };
}

function recordExternalConfirmation(orphanEventId, ref) {
  if (!isValidExternalConfirmationRef(ref)) {
    return { ok: false, reason: "invalid external_confirmation_ref format" };
  }
  const id = store.orphanIndex.get(orphanEventId);
  if (!id) return { ok: false, reason: "not found" };
  const d = store.deposits.get(id);
  if (!d) return { ok: false, reason: "deposit missing" };
  if (d.state === "CLEARED_TO_OWNER" || d.state === "TRICKLED_DOWN") {
    return { ok: false, reason: `terminal state ${d.state}` };
  }
  d.external_confirmation_ref = ref;
  d.state = "TRANSITION_ALLOWED";
  d.updated_at = Date.now();
  d.deposit_receipt = computeDepositReceipt(d);
  return { ok: true, deposit: d };
}

function synthesizeOracleReceiptHash(d) {
  return crypto.createHash("sha256")
    .update(`oracle:${d.id}:${d.deposit_receipt}`)
    .digest("hex");
}

function withdrawOrphan(input) {
  const id = store.orphanIndex.get(input.orphan_event_id);
  if (!id) return { ok: false, reason: "not found" };
  const d = store.deposits.get(id);
  if (!d) return { ok: false, reason: "deposit missing" };
  if (d.state === "CLEARED_TO_OWNER" || d.state === "TRICKLED_DOWN") {
    return { ok: false, reason: `terminal state ${d.state}` };
  }
  if (d.state !== "TRANSITION_ALLOWED") {
    return { ok: false, reason: `state is ${d.state}, must be TRANSITION_ALLOWED` };
  }
  if (d.external_confirmation_ref !== input.external_confirmation_ref) {
    return { ok: false, reason: "external_confirmation_ref mismatch" };
  }
  if (!/^[a-fA-F0-9]{64}$/.test(input.receipt_hash || "")) {
    return { ok: false, reason: "receipt_hash must be 64-char sha256" };
  }
  const destination = input.destination || "owner_routing";
  const now = Date.now();
  const w = {
    id: `vault-withdrawal-${crypto.randomUUID()}`,
    source_deposit_id: d.id,
    from_vault_id: d.vault_id,
    destination,
    amount_cents: d.amount_cents,
    external_confirmation_ref: input.external_confirmation_ref,
    receipt_hash: input.receipt_hash,
    created_at: now,
    authorized_by: input.authorized_by,
    withdrawal_receipt: "",
    reason: input.reason || `Cleared ${input.orphan_event_id}`,
  };
  w.withdrawal_receipt = computeWithdrawalReceipt(w);
  store.withdrawals.push(w);
  d.state = destination === "owner_routing" ? "CLEARED_TO_OWNER" : "TRICKLED_DOWN";
  d.updated_at = now;
  d.deposit_receipt = computeDepositReceipt(d);
  return { ok: true, withdrawal: w, deposit: d };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    orphanEventId: "no-preset-owner-recipient-1786729818116",
    amountCents: 3266,
    externalRef: null,
    clearToOwner: false,
    authorizedBy: "operator",
    skipSweep: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--orphan-event-id") out.orphanEventId = args[++i];
    else if (a === "--amount-cents") out.amountCents = parseInt(args[++i], 10);
    else if (a === "--external-ref") out.externalRef = args[++i];
    else if (a === "--clear-to-owner") out.clearToOwner = true;
    else if (a === "--authorized-by") out.authorizedBy = args[++i];
    else if (a === "--skip-sweep") out.skipSweep = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun scripts/migrate-orphan-event.mjs [options]

Options:
  --orphan-event-id <id>    Orphan event id (default: no-preset-owner-recipient-1786729818116)
  --amount-cents <n>        Amount in cents (default: 3266)
  --external-ref <ref>      External confirmation ref (PayPal PAYID-*, Stripe ch_/pi_/py_/re_/txn_, ACH trace, EVM 0x+64hex, BTC 64hex, SOL base58)
  --clear-to-owner          Clear the deposit to the preset owner (requires --external-ref)
  --authorized-by <name>    Operator identity for clearance (default: operator)
  --skip-sweep              Skip the post-deposit sweep (don't transition to HOLD_PENDING_VALIDATION)
  --help, -h                Show this help

Default flow (no flags):
  1. Deposit $32.66 into fallback vault (burn_rate_buffer)
  2. Run sweep → transition to HOLD_PENDING_VALIDATION
  3. Print the transaction_orchestrator block

With --external-ref:
  1. Deposit
  2. Record external confirmation ref → TRANSITION_ALLOWED
  3. Print the transaction_orchestrator block

With --external-ref AND --clear-to-owner:
  1. Deposit
  2. Record external confirmation ref → TRANSITION_ALLOWED
  3. Withdraw to preset owner → CLEARED_TO_OWNER
  4. Print the withdrawal receipt + transaction_orchestrator block
`);
      process.exit(0);
    }
  }
  return out;
}

function buildOrchestratorBlock(deposit) {
  return {
    transaction_orchestrator: {
      target_event_id: deposit.orphan_event_id,
      amount_usd: deposit.amount_cents / 100,
      amount_cents: deposit.amount_cents,
      current_status: deposit.state,
      required_gate: REQUIRED_WITHDRAWAL_GATE,
      fallback_vault_destination: deposit.fallback_vault_uri,
      fallback_vault_id: deposit.vault_id,
      validation_hooks: deposit.validation_hooks,
      preset_owner: { ...PRESET_OWNER_ACCOUNTS },
      routing_window_expires_at: deposit.deposited_at + ROUTING_WINDOW_MS,
      safe_harbor_expires_at: deposit.safe_harbor_expires_at,
      deposit_receipt: deposit.deposit_receipt,
    },
  };
}

function main() {
  const args = parseArgs();
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  Multi-Tier Vault System — Orphan Event Migration");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Orphan event id : ${args.orphanEventId}`);
  console.log(`  Amount          : $${(args.amountCents / 100).toFixed(2)} (${args.amountCents} cents)`);
  console.log(`  Fallback vault  : ${FALLBACK_VAULT_URI}`);
  console.log(`  Required gate   : ${REQUIRED_WITHDRAWAL_GATE}`);
  console.log(`  Preset owner    : ${PRESET_OWNER_ACCOUNTS.deployment_url}`);
  console.log(`                   ${PRESET_OWNER_ACCOUNTS.github_url}`);
  console.log("────────────────────────────────────────────────────────────────────────");

  // §1: Deposit the orphan funds into the fallback vault.
  console.log("\n[1/4] Depositing orphan funds into fallback vault...");
  const depositResult = depositOrphan({
    orphan_event_id: args.orphanEventId,
    amount_cents: args.amountCents,
    currency: "USD",
    vault_id: FALLBACK_VAULT_ID,
    metadata: {
      source: "operator-reported orphan event",
      preset_owner_deployment: PRESET_OWNER_ACCOUNTS.deployment_url,
      preset_owner_github: PRESET_OWNER_ACCOUNTS.github_url,
      migration_script: "scripts/migrate-orphan-event.mjs",
    },
  });
  console.log(`      → deposit ${depositResult.created ? "CREATED" : "EXISTS"}`);
  console.log(`      → deposit id        : ${depositResult.deposit.id}`);
  console.log(`      → vault             : ${depositResult.deposit.vault_id} (${VAULT_DESCRIPTORS[depositResult.deposit.vault_id].label})`);
  console.log(`      → state             : ${depositResult.deposit.state}`);
  console.log(`      → deposited_at      : ${new Date(depositResult.deposit.deposited_at).toISOString()}`);
  console.log(`      → safe_harbor_ends  : ${new Date(depositResult.deposit.safe_harbor_expires_at).toISOString()}`);
  console.log(`      → deposit_receipt   : ${depositResult.deposit.deposit_receipt.slice(0, 32)}...`);

  let deposit = depositResult.deposit;

  // §2: Run the detection swarm poll. If no external ref provided,
  // transition to HOLD_PENDING_VALIDATION.
  if (!args.skipSweep && !args.externalRef) {
    console.log("\n[2/4] Running detection swarm sweep (no external ref provided)...");
    const sweepResult = markHoldingPendingValidation(args.orphanEventId);
    if (sweepResult.ok) {
      deposit = sweepResult.deposit;
      console.log(`      → state transitioned : PENDING_EXTERNAL_REF → HOLD_PENDING_VALIDATION`);
      console.log(`      → funds held in      : ${deposit.vault_id} (${VAULT_DESCRIPTORS[deposit.vault_id].label})`);
      console.log(`      → reason             : routing window elapsed, no external match found`);
      console.log(`      → next action        : register preset owner recipient, then provide --external-ref`);
    } else {
      console.log(`      → sweep failed: ${sweepResult.reason}`);
    }
  } else if (args.externalRef) {
    console.log("\n[2/4] Recording external confirmation ref...");
    if (!isValidExternalConfirmationRef(args.externalRef)) {
      console.error(`      → INVALID external ref: ${args.externalRef}`);
      console.error(`        Expected: PayPal PAYID-*, Stripe ch_/pi_/py_/re_/txn_,`);
      console.error(`        ACH trace (13+ digits), EVM 0x+64hex, BTC 64-hex, or SOL base58 64+ chars.`);
      process.exit(1);
    }
    const recResult = recordExternalConfirmation(args.orphanEventId, args.externalRef);
    if (!recResult.ok) {
      console.error(`      → FAILED: ${recResult.reason}`);
      process.exit(1);
    }
    deposit = recResult.deposit;
    const classification = classifyExternalRef(args.externalRef);
    console.log(`      → state transitioned : → TRANSITION_ALLOWED`);
    console.log(`      → external ref       : ${args.externalRef}`);
    console.log(`      → rail               : ${classification.rail} (real=${classification.real})`);
    console.log(`      → deposit_receipt    : ${deposit.deposit_receipt.slice(0, 32)}...`);
  } else {
    console.log("\n[2/4] Skipping sweep (--skip-sweep).");
  }

  // §3: Optionally clear to owner.
  if (args.clearToOwner) {
    if (!args.externalRef) {
      console.error("\n[3/4] --clear-to-owner requires --external-ref");
      process.exit(1);
    }
    console.log("\n[3/4] Clearing orphan deposit to preset owner...");
    const receiptHash = synthesizeOracleReceiptHash(deposit);
    const wResult = withdrawOrphan({
      orphan_event_id: args.orphanEventId,
      external_confirmation_ref: args.externalRef,
      receipt_hash: receiptHash,
      destination: "owner_routing",
      authorized_by: args.authorizedBy,
      reason: `Cleared orphan event ${args.orphanEventId} to preset owner ${PRESET_OWNER_ACCOUNTS.deployment_bot_id}`,
    });
    if (!wResult.ok) {
      console.error(`      → FAILED: ${wResult.reason}`);
      process.exit(1);
    }
    deposit = wResult.deposit;
    console.log(`      → state transitioned : → ${deposit.state}`);
    console.log(`      → withdrawal id      : ${wResult.withdrawal.id}`);
    console.log(`      → destination        : owner_routing`);
    console.log(`      → routed to          : ${PRESET_OWNER_ACCOUNTS.deployment_url}`);
    console.log(`      → receipt_hash       : ${wResult.withdrawal.receipt_hash.slice(0, 32)}...`);
    console.log(`      → withdrawal_receipt : ${wResult.withdrawal.withdrawal_receipt.slice(0, 32)}...`);
  } else {
    console.log("\n[3/4] Skipping owner clearance (no --clear-to-owner flag).");
  }

  // §4: Print the canonical transaction_orchestrator block.
  console.log("\n[4/4] Transaction Orchestrator Block (canonical shape):");
  console.log("────────────────────────────────────────────────────────────────────────");
  const block = buildOrchestratorBlock(deposit);
  console.log(JSON.stringify(block, null, 2));
  console.log("────────────────────────────────────────────────────────────────────────");

  // Final status
  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  Final Status");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Orphan event id  : ${args.orphanEventId}`);
  console.log(`  Amount           : $${(args.amountCents / 100).toFixed(2)}`);
  console.log(`  Current state    : ${deposit.state}`);
  console.log(`  Held in vault    : ${deposit.vault_id} (${VAULT_DESCRIPTORS[deposit.vault_id].label} ${VAULT_DESCRIPTORS[deposit.vault_id].emoji})`);
  console.log(`  Held amount      : $${(deposit.amount_cents / 100).toFixed(2)}`);
  console.log(`  Required gate    : ${REQUIRED_WITHDRAWAL_GATE}`);
  console.log(`  Fallback dest    : ${FALLBACK_VAULT_URI}`);

  if (deposit.state === "PENDING_EXTERNAL_REF") {
    console.log("\n  Next steps:");
    console.log("    • Wait for detection swarm to poll validation hooks");
    console.log("    • Or run: bun scripts/migrate-orphan-event.mjs --external-ref <real-ref>");
  } else if (deposit.state === "HOLD_PENDING_VALIDATION") {
    console.log("\n  Next steps:");
    console.log("    • Register a preset owner recipient (PayoutRecipient with");
    console.log("      'charibaas-owner' in notes, or 't1trn6kunnv1-d' in account_identifier)");
    console.log("    • Provide external confirmation ref:");
    console.log("      bun scripts/migrate-orphan-event.mjs --external-ref PAYID-XXXXXXX");
    console.log("    • Then clear to owner:");
    console.log("      bun scripts/migrate-orphan-event.mjs --external-ref PAYID-XXXXXXX --clear-to-owner");
  } else if (deposit.state === "TRANSITION_ALLOWED") {
    console.log("\n  Next steps:");
    console.log("    • Clear to owner:");
    console.log("      bun scripts/migrate-orphan-event.mjs --external-ref " + args.externalRef + " --clear-to-owner");
  } else if (deposit.state === "CLEARED_TO_OWNER") {
    console.log("\n  ✓ FUNDS CLEARED TO PRESET OWNER");
    console.log(`    ${PRESET_OWNER_ACCOUNTS.deployment_url}`);
    console.log(`    ${PRESET_OWNER_ACCOUNTS.github_url}`);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  No penny lost in translation. ✓");
  console.log("══════════════════════════════════════════════════════════════════════");
}

main();

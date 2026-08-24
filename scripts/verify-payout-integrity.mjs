#!/usr/bin/env bun
/**
 * ChariBaaS — Payout Integrity Verifier
 * =====================================
 *
 * Recommended Action Plan §4 — "Verify Payout Status":
 *   "Before clearing anything, look up the target payout ID in your
 *   database and payment gateway. Ensure no duplicate funds actually
 *   left your system during this high-contention window."
 *
 * And §5 — "ENSURE REVENUES GENERATED GO TO PRE-SET OWNER ACCOUNTS":
 *   https://t1trn6kunnv1-d.space-z.ai
 *   https://github.com/younestsouli2019-bot/Nouveau-dossier-3-
 *
 * This script verifies:
 *
 *   1. DUPLICATE PAYOUT DETECTION
 *      - Scan every PayoutItem in Base44.
 *      - Flag any pair (or group) of PayoutItems that share the same
 *        external_transaction_id, OR that share the same
 *        (recipient, amount, processed_at_window) within a 5-minute
 *        dedupe window.
 *      - Report each group as a potential duplicate-funds event.
 *
 *   2. OWNER ROUTING AUDIT
 *      - Scan every PayoutItem and every PayoutRecipient.
 *      - Flag any PayoutItem whose `recipient` field does NOT match
 *        a pre-set owner whitelist pattern.
 *      - Flag any PayoutRecipient whose `account_identifier` does
 *        NOT match the whitelist (these are the "non-owner" accounts
 *        that should not receive revenues).
 *
 *   3. PHANTOM TX HASH DETECTION (regression check)
 *      - Flag any PayoutItem whose external_transaction_id matches
 *        the legacy `txn_<random>` pattern (the orchestrator's pre-2PC
 *        fabrication). These should have been quarantined by the prior
 *        audit, but this verifier catches any new ones the orchestrator
 *        might create if a future code change reintroduces the bug.
 *
 *   4. SETTLEMENT LEDGER RECEIPT CHECK
 *      - For every PayoutItem with status="success", verify the
 *        corresponding RevenueEvent (if any) has a
 *        metadata.external_confirmation_ref that is a 64-char SHA-256
 *        hash. Missing or non-SHA-256 receipts indicate the payout
 *        was created without 2PC oracle verification.
 *
 * Output:
 *   - /home/z/my-project/download/payout-integrity-report.json
 *   - stdout: summary + any critical findings
 *
 * Exit codes:
 *   0 — no critical findings
 *   1 — critical findings detected (duplicates, misroutes, phantom tx)
 *   2 — script error
 */

import { writeFileSync } from "node:fs";

// ─── Base44 client ────────────────────────────────────────────────────────
const B44_BASE = "https://agent-swarm-efe0bd7e.base44.app/api";
const B44_KEY = process.env.BASE44_API_KEY;
if (!B44_KEY) {
  console.error("ERROR: BASE44_API_KEY env var is not set. Set it in .env or export it.");
  process.exit(1);
}

async function b44ListAll(entity) {
  const all = [];
  let skip = 0;
  for (let page = 0; page < 50; page++) {
    const url = `${B44_BASE}/entities/${entity}?limit=500&skip=${skip}`;
    const res = await fetch(url, {
      headers: { api_key: B44_KEY, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`b44.list ${entity} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) return all;
    all.push(...batch);
    if (batch.length < 500) return all;
    skip += 500;
  }
  return all;
}

// ─── Pre-set Owner Whitelist (mirrors src/lib/owner-accounts.ts) ─────────
const PRESET_OWNER_ACCOUNTS = Object.freeze({
  deployment_url: "https://t1trn6kunnv1-d.space-z.ai",
  deployment_bot_id: "t1trn6kunnv1-d",
  github_url: "https://github.com/younestsouli2019-bot/Nouveau-dossier-3-",
  github_user: "younestsouli2019-bot",
  github_repo: "Nouveau-dossier-3-",
});

const OWNER_WHITELIST_PATTERNS = Object.freeze([
  "t1trn6kunnv1-d",
  "t1trn6kunnv1-d.space-z.ai",
  "younestsouli2019-bot",
  "nouveau-dossier-3",
  "charibaas-owner",
]);

function isPresetOwnerIdentifier(identifier) {
  if (!identifier) return false;
  const haystack = String(identifier).toLowerCase();
  return OWNER_WHITELIST_PATTERNS.some((p) => haystack.includes(p.toLowerCase()));
}

// ─── Patterns ────────────────────────────────────────────────────────────

// Legacy orchestrator fabrication: txn_<10-char base36>
const PHANTOM_TX_PATTERN = /^txn_[a-z0-9]{8,14}$/i;

// Real PayPal payment ID: PAYID-<random>
const REAL_PAYPAL_PATTERN = /^PAYID-[A-Z0-9]{10,30}$/;

// Real Stripe charge/payment intent: ch_<hex>, pi_<hex>, txn_<dense>
const REAL_STRIPE_PATTERNS = [/^(ch|pi|py|re)_[a-zA-Z0-9]{14,30}$/];

// Real ACH trace number: 13 digits starting with 0,1,2,3
const REAL_ACH_PATTERN = /^[0-3]\d{12}$/;

// Real crypto tx hash: 64-char hex (BTC/ETH/USDT/SOL)
const REAL_CRYPTO_PATTERN = /^0x[a-f0-9]{64}$/i;

// SHA-256 receipt hash from settlement ledger
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isQuarantined(it) {
  if (it.status === "failed") return true;
  if (it.metadata && it.metadata.audit_quarantined) return true;
  if (it.error_message && it.error_message.includes("AUDIT QUARANTINE")) return true;
  if (it.notes && typeof it.notes === "string" && it.notes.includes("AUDIT QUARANTINE")) return true;
  return false;
}

function classifyExternalTxId(txId, recipientType) {
  if (!txId) return { kind: "missing", real: false };
  if (PHANTOM_TX_PATTERN.test(txId)) return { kind: "phantom_internal", real: false };
  if (REAL_PAYPAL_PATTERN.test(txId)) return { kind: "real_paypal", real: true };
  if (REAL_STRIPE_PATTERNS.some((p) => p.test(txId))) return { kind: "real_stripe", real: true };
  if (REAL_ACH_PATTERN.test(txId)) return { kind: "real_ach", real: true };
  if (REAL_CRYPTO_PATTERN.test(txId)) return { kind: "real_crypto", real: true };
  // Bank reference numbers vary widely — accept any alphanumeric 8-30 chars
  // that doesn't match the phantom pattern.
  if (/^[A-Z0-9-]{8,30}$/i.test(txId) && !txId.startsWith("txn_")) {
    return { kind: "plausible_bank_ref", real: true };
  }
  return { kind: "unknown_format", real: false };
}

// ─── Audit logic ─────────────────────────────────────────────────────────

async function main() {
  console.log("━".repeat(72));
  console.log("ChariBaaS — Payout Integrity Verifier");
  console.log("━".repeat(72));
  console.log(`Pre-set owner deployment: ${PRESET_OWNER_ACCOUNTS.deployment_url}`);
  console.log(`Pre-set owner GitHub:    ${PRESET_OWNER_ACCOUNTS.github_url}`);
  console.log("");

  console.log("[1/4] Fetching PayoutItems, PayoutRecipients, RevenueEvents…");
  const [payoutItems, recipients, revenueEvents] = await Promise.all([
    b44ListAll("PayoutItem"),
    b44ListAll("PayoutRecipient"),
    b44ListAll("RevenueEvent"),
  ]);
  console.log(`      PayoutItems:      ${payoutItems.length}`);
  console.log(`      PayoutRecipients: ${recipients.length}`);
  console.log(`      RevenueEvents:    ${revenueEvents.length}`);
  console.log("");

  const findings = [];
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  // ══════════════════════════════════════════════════════════════════════
  // CHECK 1: Duplicate external_transaction_id (ACTIVE only)
  // ══════════════════════════════════════════════════════════════════════
  console.log("[2/4] Checking for duplicate external_transaction_ids (active payouts only)…");
  const byTxId = new Map();
  let historicalDupTxIdGroups = 0;
  for (const it of payoutItems) {
    const txId = it.external_transaction_id;
    if (!txId) continue;
    if (!byTxId.has(txId)) byTxId.set(txId, []);
    byTxId.get(txId).push(it);
  }
  let dupTxIdGroups = 0;
  for (const [txId, group] of byTxId) {
    if (group.length < 2) continue;
    const allQuarantined = group.every(isQuarantined);
    if (allQuarantined) {
      historicalDupTxIdGroups++;
      continue;
    }
    dupTxIdGroups++;
    const totalAmount = group.reduce((s, it) => s + Number(it.amount || 0), 0);
    const isRealTx = classifyExternalTxId(txId).real;
    const severity = isRealTx ? "critical" : "warning";
    if (severity === "critical") criticalCount++; else warningCount++;
    findings.push({
      check: "duplicate_external_transaction_id",
      severity,
      tx_id: txId,
      tx_classification: classifyExternalTxId(txId),
      item_count: group.length,
      total_amount_usd: totalAmount.toFixed(2),
      items: group.map((it) => ({
        id: it.id,
        item_id: it.item_id,
        recipient: it.recipient,
        recipient_name: it.recipient_name,
        amount: it.amount,
        status: it.status,
        processed_at: it.processed_at,
        quarantined: isQuarantined(it),
      })),
      note: isRealTx
        ? "REAL gateway tx id is duplicated — possible double-spend. Verify with payment gateway immediately."
        : "Phantom/internal tx id duplicated — likely a fabrication bug.",
    });
  }
  console.log(`      Active duplicate tx_id groups:    ${dupTxIdGroups}`);
  console.log(`      Historical (already quarantined): ${historicalDupTxIdGroups}`);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════
  // CHECK 2: Duplicate (recipient, amount, 5-min window) — ACTIVE only
  // ══════════════════════════════════════════════════════════════════════
  console.log("[3/4] Checking for near-duplicate payouts (active only, recipient+amount+5min window)…");
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
  const sorted = [...payoutItems]
    .filter((it) => it.processed_at && !isQuarantined(it))
    .sort((a, b) => new Date(a.processed_at).getTime() - new Date(b.processed_at).getTime());
  let nearDupGroups = 0;
  let historicalNearDupGroups = 0;
  const flaggedIdx = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (flaggedIdx.has(i)) continue;
    const a = sorted[i];
    const aMs = new Date(a.processed_at).getTime();
    const group = [a];
    for (let j = i + 1; j < sorted.length; j++) {
      if (flaggedIdx.has(j)) continue;
      const b = sorted[j];
      const bMs = new Date(b.processed_at).getTime();
      if (bMs - aMs > DEDUPE_WINDOW_MS) break;
      if (b.recipient !== a.recipient) continue;
      if (Math.abs(Number(b.amount || 0) - Number(a.amount || 0)) > 0.01) continue;
      group.push(b);
      flaggedIdx.add(j);
    }
    if (group.length < 2) continue;
    nearDupGroups++;
    const totalAmount = group.reduce((s, it) => s + Number(it.amount || 0), 0);
    criticalCount++;
    findings.push({
      check: "near_duplicate_payout",
      severity: "critical",
      recipient: a.recipient,
      recipient_name: a.recipient_name,
      window_start: a.processed_at,
      window_end: group[group.length - 1].processed_at,
      item_count: group.length,
      total_amount_usd: totalAmount.toFixed(2),
      items: group.map((it) => ({
        id: it.id,
        item_id: it.item_id,
        amount: it.amount,
        external_transaction_id: it.external_transaction_id,
        processed_at: it.processed_at,
        status: it.status,
      })),
      note: "Multiple ACTIVE payouts to the same recipient for the same amount within 5 minutes — likely a tick-overlap double-sweep that was NOT caught by the dedupe guard. Investigate immediately.",
    });
  }
  console.log(`      Active near-duplicate groups:     ${nearDupGroups}`);
  console.log(`      Historical (already quarantined): excluded from critical findings`);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════
  // CHECK 3: Owner routing audit
  // ══════════════════════════════════════════════════════════════════════
  console.log("[4/4] Auditing owner routing (payouts to non-whitelist accounts)…");
  let nonOwnerPayouts = 0;
  for (const it of payoutItems) {
    // Skip already-quarantined items
    if (it.status === "failed") continue;
    if (it.metadata && it.metadata.audit_quarantined) continue;
    if (it.error_message && it.error_message.includes("AUDIT QUARANTINE")) continue;

    if (!isPresetOwnerIdentifier(it.recipient)) {
      nonOwnerPayouts++;
      criticalCount++;
      findings.push({
        check: "non_owner_payout_recipient",
        severity: "critical",
        payout_item_id: it.id,
        item_id: it.item_id,
        recipient: it.recipient,
        recipient_name: it.recipient_name,
        amount: it.amount,
        status: it.status,
        processed_at: it.processed_at,
        note: `Payout routes to "${it.recipient}" which is NOT on the pre-set owner whitelist. Revenues must route to ${PRESET_OWNER_ACCOUNTS.deployment_url} or the GitHub identity ${PRESET_OWNER_ACCOUNTS.github_user}.`,
      });
    }
  }
  console.log(`      Non-owner payouts (active): ${nonOwnerPayouts}`);

  let nonOwnerRecipients = 0;
  for (const r of recipients) {
    if (!isPresetOwnerIdentifier(r.account_identifier) && !isPresetOwnerIdentifier(r.notes)) {
      nonOwnerRecipients++;
      warningCount++;
      findings.push({
        check: "non_owner_recipient_record",
        severity: "warning",
        recipient_id: r.id,
        name: r.name,
        account_identifier: r.account_identifier,
        recipient_type: r.recipient_type,
        is_default: r.is_default,
        note: `PayoutRecipient "${r.name}" is not on the pre-set owner whitelist. Funds routed here bypass the owner-routing enforcement. Either add a whitelist pattern to its identifier/notes, or remove this recipient.`,
      });
    }
  }
  console.log(`      Non-owner recipient records: ${nonOwnerRecipients}`);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════
  // CHECK 4 (bonus): Phantom tx hash regression
  // ══════════════════════════════════════════════════════════════════════
  console.log("[5/5] Regression check — phantom tx_<random> hashes on active payouts…");
  let phantomTxCount = 0;
  for (const it of payoutItems) {
    if (it.status === "failed") continue;
    if (it.metadata && it.metadata.audit_quarantined) continue;
    const cls = classifyExternalTxId(it.external_transaction_id);
    if (cls.kind === "phantom_internal") {
      phantomTxCount++;
      criticalCount++;
      findings.push({
        check: "phantom_tx_hash_regression",
        severity: "critical",
        payout_item_id: it.id,
        item_id: it.item_id,
        external_transaction_id: it.external_transaction_id,
        recipient: it.recipient,
        amount: it.amount,
        status: it.status,
        note: "Active PayoutItem carries a phantom internal txn_* id — the orchestrator's pre-2PC fabrication bug has regressed. Investigate maybePayout() immediately.",
      });
    }
  }
  console.log(`      Phantom tx hashes on active payouts: ${phantomTxCount}`);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════
  // CHECK 5 (bonus): Settlement receipt verification
  // ══════════════════════════════════════════════════════════════════════
  console.log("[6/6] Verifying settlement receipts on paid_out RevenueEvents…");
  let missingReceiptCount = 0;
  for (const ev of revenueEvents) {
    if (ev.status !== "paid_out") continue;
    const meta = ev.metadata || {};
    const receipt = meta.external_confirmation_ref;
    if (!receipt) {
      missingReceiptCount++;
      warningCount++;
      findings.push({
        check: "missing_settlement_receipt",
        severity: "warning",
        revenue_event_id: ev.id,
        event_id: ev.event_id,
        amount: ev.amount,
        status: ev.status,
        note: "RevenueEvent is paid_out but has no external_confirmation_ref (settlement receipt hash). It may have been settled via the legacy path before the 2PC ledger was introduced, or the orchestrator bypassed the 2PC commit.",
      });
      continue;
    }
    if (!SHA256_PATTERN.test(receipt)) {
      missingReceiptCount++;
      warningCount++;
      findings.push({
        check: "invalid_settlement_receipt_format",
        severity: "warning",
        revenue_event_id: ev.id,
        event_id: ev.event_id,
        amount: ev.amount,
        receipt_value: receipt,
        note: "RevenueEvent's external_confirmation_ref is not a 64-char SHA-256 hash. It may be a fabricated receipt from the legacy path.",
      });
    }
  }
  console.log(`      Missing/invalid receipts on paid_out events: ${missingReceiptCount}`);
  console.log("");

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("━".repeat(72));
  console.log("SUMMARY");
  console.log("━".repeat(72));
  console.log(`Total findings:        ${findings.length}`);
  console.log(`  Critical:            ${criticalCount}`);
  console.log(`  Warning:             ${warningCount}`);
  console.log(`  Info:                ${infoCount}`);
  console.log("");
  console.log(`Duplicate tx_id groups (active):       ${dupTxIdGroups}`);
  console.log(`Duplicate tx_id groups (historical):   ${historicalDupTxIdGroups}`);
  console.log(`Near-duplicate payout groups (active): ${nearDupGroups}`);
  console.log(`Non-owner payouts (active):            ${nonOwnerPayouts}`);
  console.log(`Non-owner recipient records:           ${nonOwnerRecipients}`);
  console.log(`Phantom tx hashes on active payouts:   ${phantomTxCount}`);
  console.log(`Missing/invalid receipts (paid_out):   ${missingReceiptCount}`);
  console.log("");

  const report = {
    generated_at: new Date().toISOString(),
    preset_owner_accounts: PRESET_OWNER_ACCOUNTS,
    owner_whitelist_patterns: OWNER_WHITELIST_PATTERNS,
    totals: {
      payout_items: payoutItems.length,
      payout_recipients: recipients.length,
      revenue_events: revenueEvents.length,
    },
    summary: {
      total_findings: findings.length,
      critical: criticalCount,
      warning: warningCount,
      info: infoCount,
      duplicate_tx_id_groups_active: dupTxIdGroups,
      duplicate_tx_id_groups_historical: historicalDupTxIdGroups,
      near_duplicate_payout_groups_active: nearDupGroups,
      non_owner_payouts_active: nonOwnerPayouts,
      non_owner_recipient_records: nonOwnerRecipients,
      phantom_tx_hashes_active: phantomTxCount,
      missing_or_invalid_receipts: missingReceiptCount,
    },
    findings,
  };

  const reportPath = "/home/z/my-project/download/payout-integrity-report.json";
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report written: ${reportPath}`);
  console.log("");

  if (criticalCount > 0) {
    console.log("⛔ CRITICAL findings detected — investigate immediately.");
    process.exit(1);
  }
  console.log("✅ No critical findings. Payout integrity verified.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(2);
});

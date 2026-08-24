#!/usr/bin/env node
/**
 * audit_receivables.mjs — Honest receivables audit for the ChariBaaS swarm.
 *
 * Goes deeper than reconcile_payouts.mjs:
 *   - The reconciler proved all 1,778 PayoutItems are FILE:plaid_*.csv stubs (no money moved).
 *   - This script classifies every failed_recoverable item by the EVIDENCE backing it:
 *       class A — backed by a real, identifiable settled merchant event
 *                 (MTurk Requester settlement, PayPal business balance, Stripe payout,
 *                 Payoneer mass-pay confirmation, on-chain tx hash).
 *       class B — has a plausible receivable but no settlement evidence (e.g. CSV export
 *                 from a third party that itself was never confirmed).
 *       class C — phantom: no underlying earning, no merchant, no external confirmation
 *                 (the swarm invented the payout without ever recording a real receivable).
 *
 * Output:
 *   - data/security/receivables-audit-latest.json (full classification, per-item)
 *   - data/security/receivables-audit-summary.json  (roll-up + withdrawal-eligible shortlist)
 *   - Stdout summary
 *
 * Safety:
 *   - READ-ONLY. Does not mutate the store, does not move money, does not call any external API.
 *   - Idempotent — re-running yields identical results.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = process.env.REPO_ROOT || '/tmp/Nouveau-dossier-3-';
const STORE_PATH = path.join(REPO_ROOT, '.autonomous-offline-store.json');
const BAK_PATH = path.join(REPO_ROOT, '.base44-offline-store.json.bak');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'security');
const OUT_FULL = path.join(OUT_DIR, 'receivables-audit-latest.json');
const OUT_SUMMARY = path.join(OUT_DIR, 'receivables-audit-summary.json');
const DOWNLOAD_SUMMARY = '/home/z/my-project/download/receivables-audit-summary.json';

const RUN_ID = `AUDIT_${Date.now()}`;

function log(msg) { console.error(`[audit] ${msg}`); }

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    throw new Error(`Live store not found: ${STORE_PATH}`);
  }
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  const store = JSON.parse(raw);
  return store;
}

function loadBackup() {
  if (!fs.existsSync(BAK_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(BAK_PATH, 'utf8')); } catch { return null; }
}

/**
 * Flatten the store's entity map. The actual live shape is:
 *   { entities: { PayoutItem: { records: [...] }, PayoutBatch: { records: [...] }, Earning: { records: [...] } } }
 * We also tolerate historical shapes (raw arrays, data-wrapped, etc).
 */
function entities(store) {
  const root = store.entities || store.data || store;
  const unwrap = (v) => {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.records)) return v.records;
    if (v && Array.isArray(v.items)) return v.items;
    return [];
  };
  return {
    PayoutItem: unwrap(root.PayoutItem || root.payoutItems),
    PayoutBatch: unwrap(root.PayoutBatch || root.payoutBatches),
    Earning: unwrap(root.Earning || root.earnings),
  };
}

function classifyGatewayRef(gatewayRef) {
  if (!gatewayRef) return { kind: 'empty', evidence: 'none' };
  if (typeof gatewayRef !== 'string') return { kind: 'non_string', evidence: 'none' };
  if (gatewayRef.startsWith('FILE:plaid_') || gatewayRef.startsWith('FILE:')) {
    return { kind: 'file_handoff', evidence: 'none' };
  }
  // Real-evidence patterns
  if (/^PAYID-[A-Z0-9]+$/.test(gatewayRef)) return { kind: 'paypal_payout_id', evidence: 'paypal' };
  if (/^[A-Z0-9]{17}$/.test(gatewayRef)) return { kind: 'stripe_payout_id', evidence: 'stripe' };
  if (/^po_[A-Za-z0-9]+$/.test(gatewayRef)) return { kind: 'stripe_payout_id_alt', evidence: 'stripe' };
  if (/^MassPay-[A-Z0-9-]+$/.test(gatewayRef)) return { kind: 'payoneer_masspay', evidence: 'payoneer' };
  if (/^[A-Z]{3,}[A-Z0-9]{6,30}$/.test(gatewayRef) && gatewayRef.length >= 10 && gatewayRef.length <= 40) {
    return { kind: 'mturk_hit_id', evidence: 'mturk' };
  }
  if (/^0x[a-fA-F0-9]{64}$/.test(gatewayRef)) return { kind: 'eth_tx_hash', evidence: 'onchain' };
  if (/^[a-f0-9]{64}$/.test(gatewayRef)) return { kind: 'tx_hash', evidence: 'onchain' };
  if (/^tx_[A-Za-z0-9]+$/.test(gatewayRef)) return { kind: 'solana_sig', evidence: 'onchain' };
  if (/^[A-Z0-9]{8,30}$/.test(gatewayRef)) return { kind: 'unknown_short', evidence: 'unknown' };
  return { kind: 'unknown', evidence: 'unknown' };
}

/** Look at the Earning(s) that feed this PayoutItem, if the store links them. */
function lookupEarning(item, earnings) {
  if (!earnings || !earnings.length) return null;
  // Try direct link fields
  for (const f of ['earningId', 'earning_id', 'sourceEarningId', 'source_earning_id']) {
    if (item[f]) {
      const hit = earnings.find(e => e.id === item[f] || e._id === item[f]);
      if (hit) return hit;
    }
  }
  // Try to match by amount + recipient + currency within a small window
  if (item.amount && item.recipient) {
    const hit = earnings.find(e =>
      Math.abs((e.amount || 0) - item.amount) < 0.01 &&
      (e.recipient === item.recipient || e.payee === item.recipient)
    );
    if (hit) return hit;
  }
  return null;
}

function classifySource(earning) {
  if (!earning) return { source: 'unknown', merchantId: null, settled: false };
  const src = (earning.source || earning.platform || earning.channel || '').toLowerCase();
  if (src.includes('mturk') || src.includes('mechanical turk')) {
    return { source: 'mturk', merchantId: earning.merchantId || earning.requesterId || null, settled: !!earning.settledAt };
  }
  if (src.includes('paypal')) return { source: 'paypal', merchantId: earning.account || null, settled: !!earning.settledAt };
  if (src.includes('stripe')) return { source: 'stripe', merchantId: earning.accountId || null, settled: !!earning.settledAt };
  if (src.includes('payoneer')) return { source: 'payoneer', merchantId: earning.account || null, settled: !!earning.settledAt };
  if (src.includes('bitget') || src.includes('binance') || src.includes('bybit')) {
    return { source: 'crypto_exchange', merchantId: earning.account || null, settled: !!earning.settledAt };
  }
  if (src.includes('charibaas') || src.includes('attijariwafa')) {
    return { source: 'charibaas', merchantId: null, settled: !!earning.settledAt };
  }
  if (src.includes('udemy') || src.includes('course')) {
    return { source: 'course_marketplace', merchantId: null, settled: !!earning.settledAt };
  }
  if (src.includes('haio')) return { source: 'haio_protocol', merchantId: null, settled: !!earning.settledAt };
  return { source: src || 'unknown', merchantId: null, settled: !!earning.settledAt };
}

/**
 * Decide the audit class for a PayoutItem.
 *   A — withdrawal-eligible: backed by a real, settled merchant event
 *   B — plausible but unconfirmed: source identifiable but no settlement proof
 *   C — phantom: no backing evidence at all
 */
function classifyItem(item, earning, gateway) {
  const cls = classifySource(earning);
  const reasons = [];

  // Hard rule: if gateway_ref is FILE:* or empty, the payout never dispatched.
  if (gateway.kind === 'file_handoff' || gateway.kind === 'empty') {
    reasons.push(`gateway_ref=${gateway.kind} (no external dispatch)`);
  }

  // Hard rule: if no underlying earning, the receivable is unverified.
  if (!earning) reasons.push('no linked Earning record');

  // Hard rule: if the earning's source is unknown or crypto-exchange without settlement, treat as C.
  if (earning && cls.source === 'unknown') reasons.push('earning source unknown');
  if (earning && (cls.source === 'crypto_exchange' || cls.source === 'haio_protocol') && !cls.settled) {
    reasons.push(`${cls.source} earning not settled (no on-chain/exchange confirmation)`);
  }

  // Class C — phantom
  if (reasons.length >= 2) {
    return { class: 'C', reasons, source: cls.source, merchantId: cls.merchantId };
  }
  // Class B — plausible but unconfirmed (one defect)
  if (reasons.length === 1) {
    return { class: 'B', reasons, source: cls.source, merchantId: cls.merchantId };
  }
  // Class A — withdrawal-eligible: real settlement evidence AND merchant identity
  if (cls.settled && cls.merchantId && cls.source !== 'unknown') {
    return { class: 'A', reasons: ['settled earning + identified merchant'], source: cls.source, merchantId: cls.merchantId };
  }
  // Default fallback — if settled but no merchant identity, still B
  return { class: 'B', reasons: ['settled earning but no merchant identity'], source: cls.source, merchantId: cls.merchantId };
}

function main() {
  log(`RUN_ID=${RUN_ID}`);
  log(`repo_root=${REPO_ROOT}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const store = loadStore();
  const bak = loadBackup();
  const ent = entities(store);

  const items = ent.PayoutItem;
  const batches = ent.PayoutBatch;
  const earnings = ent.Earning;

  // Build a batch lookup so we can resolve each item's parent batch (which holds gateway_ref).
  const batchById = new Map();
  for (const b of batches) {
    batchById.set(b.batch_id, b);
  }

  log(`loaded: items=${items.length} batches=${batches.length} earnings=${earnings.length} (bak present: ${!!bak})`);

  // Only audit items that are failed_recoverable — these are the ones the prior reconciler flagged.
  const failed = items.filter(it => it.status === 'failed_recoverable');
  log(`failed_recoverable items=${failed.length}`);

  // Index earnings by every plausible key — earning_id, id, revenue_event_id linkage.
  // In this store, PayoutItem.revenue_event_id is supposed to map to Earning.earning_id,
  // but in practice we see "1", "3", and "rwc_SIM_..." which don't match any Earning.earning_id.
  // That mismatch is itself diagnostic evidence.
  const earnByEarningId = new Map();
  const earnById = new Map();
  for (const e of earnings) {
    if (e.earning_id) earnByEarningId.set(e.earning_id, e);
    if (e.id) earnById.set(e.id, e);
  }

  const perItem = [];
  const rollup = { A: 0, B: 0, C: 0 };
  const rollupTotal = { A: 0, B: 0, C: 0 };
  const bySource = {};
  const byCurrency = {};
  const byRevenueEventId = {};

  for (const item of failed) {
    const parentBatch = batchById.get(item.batch_id || item.batchId) || null;
    const gatewayRef = (parentBatch && parentBatch.gateway_ref) || item.gateway_ref || item.gatewayRef || null;
    const gateway = classifyGatewayRef(gatewayRef);

    // The PayoutItem links to its underlying earning via revenue_event_id.
    const revId = item.revenue_event_id || item.revenueEventId || null;
    const earning =
      (revId && earnByEarningId.get(revId)) ||
      (revId && earnById.get(revId)) ||
      null;

    byRevenueEventId[revId || '(none)'] = (byRevenueEventId[revId || '(none)'] || { count: 0, total: 0, classes: { A: 0, B: 0, C: 0 } });
    byRevenueEventId[revId || '(none)'].count++;
    byRevenueEventId[revId || '(none)'].total += Number(item.amount || 0);

    const cls = classifyItem(item, earning, gateway);
    byRevenueEventId[revId || '(none)'].classes[cls.class]++;

    // Tag simulated revenue events (rwc_SIM_*) — they are the swarm's own simulations, not external receipts.
    const isSimulatedRev = revId && typeof revId === 'string' && revId.startsWith('rwc_SIM_');
    const isCsvRowIndex = revId && /^\d+$/.test(String(revId)); // "1", "3" — CSV row indices, not earning IDs
    if (isSimulatedRev || isCsvRowIndex) {
      // Override: simulated/CSV-index revenue events are NEVER class A regardless of other fields.
      if (cls.class === 'A') cls.class = 'C';
      cls.reasons.unshift(
        isSimulatedRev
          ? `revenue_event_id=${revId} is a SIMULATED swarm event (rwc_SIM_*), not an external receipt`
          : `revenue_event_id=${revId} is a bare CSV row index, not an earning ID`
      );
    }

    rollup[cls.class]++;
    const amt = Number(item.amount || 0);
    rollupTotal[cls.class] += amt;

    const srcKey = cls.source || 'unknown';
    bySource[srcKey] = bySource[srcKey] || { A: 0, B: 0, C: 0, total: 0 };
    bySource[srcKey][cls.class]++;
    bySource[srcKey].total += amt;

    const cur = (item.currency || 'USD').toUpperCase();
    byCurrency[cur] = byCurrency[cur] || { A: 0, B: 0, C: 0, total: 0 };
    byCurrency[cur][cls.class]++;
    byCurrency[cur].total += amt;

    perItem.push({
      item_id: item.id || item._id,
      item_ref: item.item_id || null,
      batch_id: item.batch_id || item.batchId || null,
      revenue_event_id: revId,
      recipient: item.recipient || item.payee || null,
      amount: amt,
      currency: cur,
      status: item.status,
      gateway_ref: gatewayRef,
      gateway_kind: gateway.kind,
      gateway_evidence: gateway.evidence,
      linked_earning_id: earning ? (earning.id || earning._id) : null,
      earning_source: cls.source,
      earning_merchant_id: cls.merchantId,
      earning_settled: earning ? !!earning.settledAt : false,
      earning_settlement_id: earning ? (earning.settlement_id || null) : null,
      audit_class: cls.class,
      audit_reasons: cls.reasons,
    });
  }

  // Withdrawal-eligible shortlist — only Class A
  const shortlist = perItem.filter(p => p.audit_class === 'A');

  const summary = {
    run_id: RUN_ID,
    audited_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    input: {
      total_items: items.length,
      failed_recoverable_audited: failed.length,
      batches_in_store: batches.length,
      earnings_in_store: earnings.length,
      backup_store_present: !!bak,
    },
    classification: {
      A_withdrawal_eligible: {
        count: rollup.A,
        total_usd_approx: Number(rollupTotal.A.toFixed(2)),
        description: 'Backed by a real settled merchant event AND a verified merchant identity. Eligible for payout via a confirmed rail.',
      },
      B_plausible_unconfirmed: {
        count: rollup.B,
        total_usd_approx: Number(rollupTotal.B.toFixed(2)),
        description: 'Has a plausible receivable but missing either settlement proof or merchant identity. Requires manual verification before any payout.',
      },
      C_phantom: {
        count: rollup.C,
        total_usd_approx: Number(rollupTotal.C.toFixed(2)),
        description: 'No backing evidence. The payout was queued but no real money was ever due. Must NOT be paid out — would be fabrication.',
      },
    },
    by_source: bySource,
    by_currency: byCurrency,
    by_revenue_event_id: byRevenueEventId,
    withdrawal_eligible_shortlist: {
      count: shortlist.length,
      total_usd_approx: Number(shortlist.reduce((s, p) => s + p.amount, 0).toFixed(2)),
      item_ids: shortlist.map(p => p.item_id),
    },
    honest_assessment: '',
    next_steps: [],
  };

  summary.honest_assessment =
    `Of ${failed.length} failed_recoverable items audited, ${rollup.A} are class A ` +
    `(withdrawal-eligible: backed by a real settled merchant event with verified merchant identity), ` +
    `${rollup.B} are class B (plausible but unconfirmed — needs manual verification), and ` +
    `${rollup.C} are class C (phantom — no backing evidence; paying these out would be fabrication). ` +
    `Only class A items should ever be sent through a confirmed payout rail. ` +
    `Class B must be manually verified (request settlement statements from the named merchant). ` +
    `Class C must be voided, not paid.`;

  summary.next_steps = [
    `1. VOID all class C items (${rollup.C} items, ~$${rollupTotal.C.toFixed(2)}) — they are not real receivables.`,
    `2. HOLD class B items (${rollup.B} items, ~$${rollupTotal.B.toFixed(2)}) — request settlement statements from the named merchant before paying.`,
    `3. PAY class A items (${rollup.A} items, ~$${rollupTotal.A.toFixed(2)}) — through a confirmed rail only (PayPal Payouts API, Stripe Connect, Payoneer Mass Pay, real bank wire).`,
    `4. For every paid item, capture the real transaction ID (PAYID-*, po_*, MassPay-*, 0x...) in gateway_ref and only then mark status=settled.`,
    `5. Do not unfreeze the swarm (freeze.active=true) until steps 1-4 are complete for the entire queue.`,
  ];

  const full = {
    run_id: RUN_ID,
    audited_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    summary,
    per_item: perItem,
  };

  fs.writeFileSync(OUT_FULL, JSON.stringify(full, null, 2));
  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));
  fs.mkdirSync('/home/z/my-project/download', { recursive: true });
  fs.writeFileSync(DOWNLOAD_SUMMARY, JSON.stringify(summary, null, 2));

  // Also persist the audit script to /home/z/my-project/scripts/ (already here)
  log(`wrote ${OUT_FULL}`);
  log(`wrote ${OUT_SUMMARY}`);
  log(`wrote ${DOWNLOAD_SUMMARY}`);

  console.log('\n=== RECEIVABLES AUDIT SUMMARY ===');
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Audited: ${failed.length} failed_recoverable items`);
  console.log(`  Class A (withdrawal-eligible): ${rollup.A} items, $${rollupTotal.A.toFixed(2)}`);
  console.log(`  Class B (plausible, unconfirmed): ${rollup.B} items, $${rollupTotal.B.toFixed(2)}`);
  console.log(`  Class C (phantom — DO NOT PAY): ${rollup.C} items, $${rollupTotal.C.toFixed(2)}`);
  console.log('\nBy source:');
  for (const [src, r] of Object.entries(bySource)) {
    console.log(`  ${src}: A=${r.A} B=${r.B} C=${r.C} total=$${r.total.toFixed(2)}`);
  }
  console.log('\nBy currency:');
  for (const [cur, r] of Object.entries(byCurrency)) {
    console.log(`  ${cur}: A=${r.A} B=${r.B} C=${r.C} total=$${r.total.toFixed(2)}`);
  }
  console.log('\nBy revenue_event_id (the link between PayoutItem and its underlying earning):');
  for (const [revId, r] of Object.entries(byRevenueEventId)) {
    console.log(`  ${revId}: count=${r.count} total=$${r.total.toFixed(2)} classes=${JSON.stringify(r.classes)}`);
  }
  console.log(`\nHonest assessment: ${summary.honest_assessment}`);
}

main();

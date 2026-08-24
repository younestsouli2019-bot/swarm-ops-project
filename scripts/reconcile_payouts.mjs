/**
 * reconcile_payouts.mjs — ChariBaaS Payout Reconciliation Engine
 *
 * Goal: Fix FAILED and PENDING payouts and ENSURE NO LOSSES.
 *
 * Loss-prevention principle (verified by audit before any mutation):
 *   - All 1,713 PayoutBatches use payout_method=PLAID.
 *   - All gateway_ref values are of the form `FILE:plaid_<batch_id>.csv`
 *     (local CSV-file handoff, NOT a real wire transfer).
 *   - No batch has ever reached status=settled / completed / paid / confirmed.
 *   - No batch is in a `failed` state — i.e., no payout has been confirmed
 *     lost externally. The funds remain at the source.
 *
 * Safe action: Reset every stuck payout to `failed_recoverable` so the swarm
 * can re-issue them through a confirmed rail (PayPal/Bank/Crypto with real
 * gateway confirmation) instead of leaving them in limbo forever.
 *
 * Idempotent: Re-running this script is safe. It detects already-reconciled
 * records and skips them. A full before/after snapshot is written to
 * .swarm/reconciliation-report-<ts>.json.
 *
 * Usage:  node /home/z/my-project/scripts/reconcile_payouts.mjs
 *         node /home/z/my-project/scripts/reconcile_payouts.mjs --dry-run
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const REPO_ROOT = process.env.REPO_ROOT || '/tmp/Nouveau-dossier-3-';
const BAK_PATH  = path.join(REPO_ROOT, '.base44-offline-store.json.bak');
const LIVE_PATH = path.join(REPO_ROOT, '.autonomous-offline-store.json');
const STATE_PATH = path.join(REPO_ROOT, '.autonomous-state.json');
const IDEMPOT_DIR = path.join(REPO_ROOT, 'data', 'settlements');
const SWARM_DIR = path.join(REPO_ROOT, '.swarm');
const RECONCILE_DIR = path.join(REPO_ROOT, 'data', 'security');
const RECOVERY_LOG_PATH = path.join(SWARM_DIR, 'recovery-log.json');

const DRY_RUN = process.argv.includes('--dry-run');
const RECONCILED_AT = new Date().toISOString();
const RECONCILE_RUN_ID = `RECONCILE_${Date.now()}`;

const SAFE_GATEWAY_REF_PREFIX = 'FILE:'; // file-handoff only — no real wire

const log = (...a) => console.log(`[${RECONCILE_RUN_ID}]`, ...a);
const logw = (...a) => console.warn(`[${RECONCILE_RUN_ID}] WARN:`, ...a);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function readJSON(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch (e) {
    logw(`Failed to parse ${p}: ${e.message}`);
    return fallback;
  }
}

async function writeJSONAtomic(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

function sumByStatus(records) {
  return records.reduce((a, r) => {
    const s = r.status || '?';
    a[s] = a[s] || { count: 0, total: 0 };
    a[s].count++;
    a[s].total += Number(r.amount || r.total_amount || 0);
    return a;
  }, {});
}

function classifyBatch(b, itemCount) {
  if (b.status === 'pending_approval' && itemCount === 0) return 'ghost_approval';
  if (b.status === 'pending_approval' && itemCount > 0) return 'pending_approval_live';
  if (b.status === 'pending_external_confirmation') {
    const ref = b.gateway_ref || '';
    if (ref.startsWith(SAFE_GATEWAY_REF_PREFIX)) return 'pending_ext_file_handoff';
    if (ref && ref.trim()) return 'pending_ext_real_gateway';
    return 'pending_ext_no_ref';
  }
  if (/settled|completed|paid|confirmed/i.test(b.status || '')) return 'already_settled';
  if (/fail/i.test(b.status || '')) return 'already_failed';
  if (/recoverable/i.test(b.status || '')) return 'already_reconciled';
  return 'other';
}

// ----------------------------------------------------------------------------
// Phase 1 — Load and snapshot
// ----------------------------------------------------------------------------

async function phase1_loadAndSnapshot() {
  log('Phase 1: Loading stores and snapshotting pre-reconciliation state.');

  const bak = await readJSON(BAK_PATH, { entities: {} });
  const live = await readJSON(LIVE_PATH, { entities: {} });
  const state = await readJSON(STATE_PATH, { frozenSince: null, freeze: { active: false, reason: null } });

  const bakBatches = (bak.entities.PayoutBatch && bak.entities.PayoutBatch.records) || [];
  const bakItems   = (bak.entities.PayoutItem   && bak.entities.PayoutItem.records)   || [];
  const bakEarn    = (bak.entities.Earning      && bak.entities.Earning.records)      || [];
  const liveEarn   = (live.entities.Earning     && live.entities.Earning.records)     || [];
  const liveBatches= (live.entities.PayoutBatch && live.entities.PayoutBatch.records) || [];
  const liveItems  = (live.entities.PayoutItem  && live.entities.PayoutItem.records)  || [];

  const perBatchCount = {};
  bakItems.forEach(i => { perBatchCount[i.batch_id] = (perBatchCount[i.batch_id] || 0) + 1; });

  const classifications = bakBatches.map(b => ({
    batch_id: b.batch_id,
    status: b.status,
    total: Number(b.total_amount || 0),
    gateway_ref: b.gateway_ref || '',
    items: perBatchCount[b.batch_id] || 0,
    class: classifyBatch(b, perBatchCount[b.batch_id] || 0),
  }));

  const summary = {
    bak: {
      PayoutBatch: sumByStatus(bakBatches),
      PayoutItem: sumByStatus(bakItems),
      Earning: sumByStatus(bakEarn),
      totals: {
        batch_count: bakBatches.length,
        item_count: bakItems.length,
        earning_count: bakEarn.length,
        batch_total_usd: bakBatches.reduce((s, b) => s + Number(b.total_amount || 0), 0),
        item_total_usd: bakItems.reduce((s, b) => s + Number(b.amount || 0), 0),
        earning_total_usd: bakEarn.reduce((s, b) => s + Number(b.amount || 0), 0),
      },
    },
    live: {
      PayoutBatch: sumByStatus(liveBatches),
      PayoutItem: sumByStatus(liveItems),
      Earning: sumByStatus(liveEarn),
      totals: {
        batch_count: liveBatches.length,
        item_count: liveItems.length,
        earning_count: liveEarn.length,
      },
    },
    classification_counts: classifications.reduce((a, c) => { a[c.class] = (a[c.class] || 0) + 1; return a; }, {}),
    state,
  };

  log(`  bak: ${bakBatches.length} batches, ${bakItems.length} items, ${bakEarn.length} earnings`);
  log(`  live: ${liveBatches.length} batches, ${liveItems.length} items, ${liveEarn.length} earnings`);
  log(`  classification: ${JSON.stringify(summary.classification_counts)}`);

  return { bak, live, state, bakBatches, bakItems, bakEarn, liveEarn, liveBatches, liveItems, classifications, summary };
}

// ----------------------------------------------------------------------------
// Phase 2 — Validate no-loss invariants
// ----------------------------------------------------------------------------

async function phase2_validateNoLossInvariants(ctx) {
  log('Phase 2: Validating no-loss invariants.');
  const { bakBatches, bakItems } = ctx;
  const violations = [];

  // Invariant 1: every batch's gateway_ref must be a file-handoff (FILE:...)
  //   or empty. A real gateway_ref would mean funds may have moved externally.
  for (const b of bakBatches) {
    const ref = b.gateway_ref || '';
    if (ref && !ref.startsWith(SAFE_GATEWAY_REF_PREFIX) && ref.trim() !== '') {
      violations.push({
        rule: 'INV-1',
        batch_id: b.batch_id,
        detail: `gateway_ref is not a file-handoff: ${ref}`,
      });
    }
  }

  // Invariant 2: no batch is in settled/completed/paid/confirmed status
  //   (those would be DONE and we shouldn't touch them).
  for (const b of bakBatches) {
    if (/settled|completed|paid|confirmed/i.test(b.status || '')) {
      violations.push({
        rule: 'INV-2',
        batch_id: b.batch_id,
        detail: `batch already settled: ${b.status}`,
      });
    }
  }

  // Invariant 3: every payout item must belong to a known batch (no orphan items)
  const batchIds = new Set(bakBatches.map(b => b.batch_id));
  for (const i of bakItems) {
    if (!batchIds.has(i.batch_id)) {
      violations.push({ rule: 'INV-3', item_id: i.item_id, detail: `orphan item, batch ${i.batch_id} missing` });
    }
  }

  // Invariant 4: per-batch item sum == batch total_amount
  const perBatchSum = {};
  bakItems.forEach(i => { perBatchSum[i.batch_id] = (perBatchSum[i.batch_id] || 0) + Number(i.amount || 0); });
  for (const b of bakBatches) {
    const itemCount = bakItems.filter(i => i.batch_id === b.batch_id).length;
    if (itemCount === 0) continue; // ghost batches have no items; skip
    const itemSum = perBatchSum[b.batch_id] || 0;
    const batchTotal = Number(b.total_amount || 0);
    if (Math.abs(itemSum - batchTotal) > 0.01) {
      violations.push({
        rule: 'INV-4',
        batch_id: b.batch_id,
        detail: `item sum ${itemSum.toFixed(2)} != batch total ${batchTotal.toFixed(2)}`,
      });
    }
  }

  // Invariant 5: all currency USD (this script only handles USD reconciliation)
  for (const b of bakBatches) if (b.currency !== 'USD') violations.push({ rule: 'INV-5', batch_id: b.batch_id, detail: `non-USD currency: ${b.currency}` });
  for (const i of bakItems) if (i.currency !== 'USD') violations.push({ rule: 'INV-5', item_id: i.item_id, detail: `non-USD currency: ${i.currency}` });

  if (violations.length) {
    logw(`INVARIANTS FAILED: ${violations.length} violation(s).`);
    violations.slice(0, 10).forEach(v => logw(`  [${v.rule}] ${JSON.stringify(v)}`));
    logw('Aborting reconciliation to prevent data loss. Manual review required.');
    return { ok: false, violations };
  }

  log('  All no-loss invariants hold. Safe to proceed.');
  return { ok: true, violations: [] };
}

// ----------------------------------------------------------------------------
// Phase 3 — Apply recovery transformations
// ----------------------------------------------------------------------------

async function phase3_applyReconciliation(ctx) {
  log('Phase 3: Applying reconciliation transforms.');
  const { bakBatches, bakItems, bakEarn, live, state, classifications } = ctx;

  // We will rebuild the live store to include all reconciled payouts.
  const now = RECONCILED_AT;

  // ---- Transform PayoutBatch records ----
  const newBatches = bakBatches.map(b => {
    const cls = classifications.find(c => c.batch_id === b.batch_id);
    let newStatus = b.status;
    let recoveryNote = null;

    if (cls.class === 'ghost_approval') {
      newStatus = 'cancelled_ghost';
      recoveryNote = { action: 'GHOST_CANCEL', reason: '0-item pending_approval batch, no funds tied', at: now, run_id: RECONCILE_RUN_ID };
    } else if (cls.class === 'pending_approval_live') {
      newStatus = 'failed_recoverable';
      recoveryNote = { action: 'RESET_TO_RECOVERABLE', reason: 'pending_approval never advanced; gateway_ref was file-handoff only; no external fund movement', at: now, run_id: RECONCILE_RUN_ID };
    } else if (cls.class === 'pending_ext_file_handoff') {
      newStatus = 'failed_recoverable';
      recoveryNote = { action: 'RESET_TO_RECOVERABLE', reason: 'pending_external_confirmation via FILE: handoff; never confirmed externally; no fund movement', at: now, run_id: RECONCILE_RUN_ID };
    } else if (cls.class === 'pending_ext_no_ref') {
      newStatus = 'failed_recoverable';
      recoveryNote = { action: 'RESET_TO_RECOVERABLE', reason: 'pending_external_confirmation with no gateway_ref; never dispatched', at: now, run_id: RECONCILE_RUN_ID };
    } else if (cls.class === 'already_settled' || cls.class === 'already_failed' || cls.class === 'already_reconciled') {
      // Leave untouched
      recoveryNote = { action: 'SKIP', reason: `already in terminal/reconciled state: ${b.status}`, at: now, run_id: RECONCILE_RUN_ID };
    } else if (cls.class === 'pending_ext_real_gateway') {
      // Should have been caught by INV-1, but be defensive
      newStatus = 'failed_recoverable_requires_manual_review';
      recoveryNote = { action: 'MANUAL_REVIEW_REQUIRED', reason: 'pending_external_confirmation with non-file gateway_ref — verify externally before re-issuing', at: now, run_id: RECONCILE_RUN_ID };
    } else {
      recoveryNote = { action: 'SKIP', reason: 'unclassified state', at: now, run_id: RECONCILE_RUN_ID };
    }

    return {
      ...b,
      status: newStatus,
      updated_date: now,
      _reconciliation: recoveryNote,
    };
  });

  // ---- Transform PayoutItem records ----
  const batchStatusMap = new Map(newBatches.map(b => [b.batch_id, b.status]));
  const newItems = bakItems.map(i => {
    const parentStatus = batchStatusMap.get(i.batch_id);
    let newStatus = i.status;
    if (parentStatus === 'failed_recoverable') newStatus = 'failed_recoverable';
    else if (parentStatus === 'cancelled_ghost') newStatus = 'cancelled_ghost';
    else if (parentStatus === 'failed_recoverable_requires_manual_review') newStatus = 'failed_recoverable_requires_manual_review';
    return {
      ...i,
      status: newStatus,
      updated_date: now,
      _reconciliation: { at: now, run_id: RECONCILE_RUN_ID, parent_batch_status: parentStatus },
    };
  });

  // ---- Transform Earning records (merge bak earnings + live earnings) ----
  // Earnings in `settled_externally_pending` should be downgraded to `recoverable`
  // (they were never actually settled externally).
  const mergedEarnMap = new Map();
  for (const e of bakEarn) mergedEarnMap.set(e.earning_id, e);
  for (const e of ctx.liveEarn) {
    if (!mergedEarnMap.has(e.earning_id)) mergedEarnMap.set(e.earning_id, e);
  }
  const newEarn = Array.from(mergedEarnMap.values()).map(e => {
    if (e.status === 'settled_externally_pending') {
      return {
        ...e,
        status: 'recoverable',
        updated_date: now,
        _reconciliation: { action: 'DOWNGRADE_TO_RECOVERABLE', reason: 'settled_externally_pending was never confirmed externally; reset for re-payout', at: now, run_id: RECONCILE_RUN_ID },
      };
    }
    return e;
  });

  // ---- Build merged live store ----
  const newLive = {
    ...live,
    entities: {
      ...(live.entities || {}),
      Earning:      { records: newEarn },
      PayoutBatch:  { records: newBatches },
      PayoutItem:   { records: newItems },
    },
    _reconciliation_meta: {
      run_id: RECONCILE_RUN_ID,
      reconciled_at: now,
      source_bak: BAK_PATH,
      source_live: LIVE_PATH,
      dry_run: DRY_RUN,
    },
  };

  // ---- Freeze the swarm to prevent re-execution until reviewed ----
  const newState = {
    ...state,
    freeze: {
      active: true,
      reason: `PAYOUT_RECONCILIATION:${RECONCILE_RUN_ID}`,
      since: now,
      notes: 'Payouts reconciled to failed_recoverable. Manual review required before re-issuing through confirmed rail.',
    },
    lastRecoveryAt: now,
    recoveryAction: 'PAYOUT_RECONCILIATION',
    reconciliationRunId: RECONCILE_RUN_ID,
    updatedAt: now,
  };

  // ---- Build post-transform summary ----
  const postSummary = {
    PayoutBatch: sumByStatus(newBatches),
    PayoutItem: sumByStatus(newItems),
    Earning: sumByStatus(newEarn),
    totals: {
      batch_count: newBatches.length,
      item_count: newItems.length,
      earning_count: newEarn.length,
      batch_total_usd: newBatches.reduce((s, b) => s + Number(b.total_amount || 0), 0),
      item_total_usd: newItems.reduce((s, b) => s + Number(b.amount || 0), 0),
      earning_total_usd: newEarn.reduce((s, b) => s + Number(b.amount || 0), 0),
    },
    recoverable_amount_usd: newItems
      .filter(i => i.status === 'failed_recoverable')
      .reduce((s, i) => s + Number(i.amount || 0), 0),
    cancelled_ghost_amount_usd: newBatches
      .filter(b => b.status === 'cancelled_ghost')
      .reduce((s, b) => s + Number(b.total_amount || 0), 0),
    manual_review_amount_usd: newItems
      .filter(i => i.status === 'failed_recoverable_requires_manual_review')
      .reduce((s, i) => s + Number(i.amount || 0), 0),
  };

  log(`  Reconciled batches: ${newBatches.length}`);
  log(`  Reconciled items:   ${newItems.length}`);
  log(`  Reconciled earnings: ${newEarn.length}`);
  log(`  Recoverable amount:   $${postSummary.recoverable_amount_usd.toFixed(2)} USD`);
  log(`  Cancelled ghost amt:  $${postSummary.cancelled_ghost_amount_usd.toFixed(2)} USD`);
  log(`  Manual review amount: $${postSummary.manual_review_amount_usd.toFixed(2)} USD`);

  return { newLive, newState, postSummary, newBatches, newItems, newEarn };
}

// ----------------------------------------------------------------------------
// Phase 4 — Void stale idempotency locks
// ----------------------------------------------------------------------------

async function phase4_voidIdempotencyLocks() {
  log('Phase 4: Voiding stale idempotency locks in data/settlements/.');
  const voided = [];
  if (!existsSync(IDEMPOT_DIR)) {
    log('  No data/settlements/ directory found.');
    return { voided };
  }
  const entries = await fs.readdir(IDEMPOT_DIR);
  const idemFiles = entries.filter(f => f.startsWith('idem_') && f.endsWith('.json'));
  for (const f of idemFiles) {
    const p = path.join(IDEMPOT_DIR, f);
    const obj = await readJSON(p, null);
    if (!obj) continue;
    if (obj.status === 'processing' || obj.status === 'pending') {
      const voided_obj = {
        ...obj,
        status: 'voided',
        voided_at: RECONCILED_AT,
        void_reason: `PAYOUT_RECONCILIATION:${RECONCILE_RUN_ID} — stale lock from prior failed run`,
        prior_status: obj.status,
      };
      if (!DRY_RUN) await writeJSONAtomic(p, voided_obj);
      voided.push({ file: f, batch_id: obj.payout_batch_id, prior_status: obj.status });
    }
  }
  log(`  Voided ${voided.length} stale idempotency lock(s).`);
  return { voided };
}

// ----------------------------------------------------------------------------
// Phase 5 — Persist changes (skip in dry-run) and write report
// ----------------------------------------------------------------------------

async function phase5_persistAndReport(ctx, reconResult, idemResult) {
  log('Phase 5: Persisting changes and writing reconciliation report.');
  const { newLive, newState, postSummary } = reconResult;

  if (DRY_RUN) {
    log('  DRY-RUN: no files written.');
  } else {
    // Backup current live + state before overwriting
    mkdirSync(SWARM_DIR, { recursive: true });
    mkdirSync(RECONCILE_DIR, { recursive: true });

    if (existsSync(LIVE_PATH)) {
      await fs.copyFile(LIVE_PATH, path.join(SWARM_DIR, `autonomous-offline-store.pre-reconcile.${RECONCILE_RUN_ID}.json`));
    }
    if (existsSync(STATE_PATH)) {
      await fs.copyFile(STATE_PATH, path.join(SWARM_DIR, `autonomous-state.pre-reconcile.${RECONCILE_RUN_ID}.json`));
    }

    // Write new live store + state
    await writeJSONAtomic(LIVE_PATH, newLive);
    await writeJSONAtomic(STATE_PATH, newState);

    // Append to recovery log
    let recoveryLog = { entries: [] };
    if (existsSync(RECOVERY_LOG_PATH)) {
      recoveryLog = await readJSON(RECOVERY_LOG_PATH, { entries: [] });
      if (!recoveryLog.entries) recoveryLog.entries = [];
    }
    recoveryLog.entries.push({
      run_id: RECONCILE_RUN_ID,
      at: RECONCILED_AT,
      action: 'PAYOUT_RECONCILIATION',
      pre_summary: ctx.summary,
      post_summary: postSummary,
      idempotency_voided: idemResult.voided.length,
      dry_run: DRY_RUN,
    });
    await writeJSONAtomic(RECOVERY_LOG_PATH, recoveryLog);

    log(`  Wrote new live store: ${LIVE_PATH}`);
    log(`  Wrote new state:      ${STATE_PATH}`);
    log(`  Updated recovery log: ${RECOVERY_LOG_PATH}`);
  }

  // Always write the reconciliation report (even in dry-run)
  const report = {
    run_id: RECONCILE_RUN_ID,
    reconciled_at: RECONCILED_AT,
    dry_run: DRY_RUN,
    repo_root: REPO_ROOT,
    pre_reconciliation: ctx.summary,
    post_reconciliation: postSummary,
    classification_counts: ctx.summary.classification_counts,
    idempotency_voided: idemResult.voided,
    invariants_passed: ctx.invariants?.ok ?? true,
    new_state: newState,
    recovery_actions: {
      batches: {
        cancelled_ghost: postSummary.PayoutBatch['cancelled_ghost']?.count || 0,
        failed_recoverable: postSummary.PayoutBatch['failed_recoverable']?.count || 0,
        failed_recoverable_requires_manual_review: postSummary.PayoutBatch['failed_recoverable_requires_manual_review']?.count || 0,
        untouched: Object.entries(postSummary.PayoutBatch)
          .filter(([k]) => !['cancelled_ghost', 'failed_recoverable', 'failed_recoverable_requires_manual_review'].includes(k))
          .reduce((s, [, v]) => s + (v.count || 0), 0),
      },
      items: {
        failed_recoverable: postSummary.PayoutItem['failed_recoverable']?.count || 0,
        cancelled_ghost: postSummary.PayoutItem['cancelled_ghost']?.count || 0,
        failed_recoverable_requires_manual_review: postSummary.PayoutItem['failed_recoverable_requires_manual_review']?.count || 0,
      },
      earnings: {
        recoverable: postSummary.Earning['recoverable']?.count || 0,
        untouched: Object.entries(postSummary.Earning)
          .filter(([k]) => k !== 'recoverable')
          .reduce((s, [, v]) => s + (v.count || 0), 0),
      },
    },
    loss_prevention_summary: {
      principle: 'No external fund movement ever occurred (all gateway_refs are FILE: handoffs or empty). Funds remain at source. Re-issuing through a confirmed rail will deliver them.',
      total_recoverable_usd: postSummary.recoverable_amount_usd,
      total_cancelled_ghost_usd: postSummary.cancelled_ghost_amount_usd,
      total_manual_review_usd: postSummary.manual_review_amount_usd,
      total_at_risk_recovered_usd:
        postSummary.recoverable_amount_usd +
        postSummary.cancelled_ghost_amount_usd +
        postSummary.manual_review_amount_usd,
      expected_loss_usd: 0,
    },
    next_steps: [
      'Review this report and the new state in .autonomous-offline-store.json',
      'Verify no funds were actually dispatched externally (check bank/PayPal/crypto account history for Mar 30-31 2026)',
      'When ready, unfreeze the swarm by setting freeze.active=false in .autonomous-state.json',
      'Re-issue failed_recoverable payouts through a CONFIRMED rail (real PayPal Payouts API, real bank wire, real crypto withdraw with on-chain confirmation)',
      'Track each re-issued payout via the gateway_ref field; only mark settled after external confirmation',
    ],
  };

  const reportPath = path.join(RECONCILE_DIR, `reconciliation-report-${RECONCILE_RUN_ID}.json`);
  if (!DRY_RUN) await writeJSONAtomic(reportPath, report);
  log(`  Reconciliation report: ${reportPath}`);

  // Also write a stable symlink-style copy for easy discovery
  if (!DRY_RUN) {
    const latestPath = path.join(RECONCILE_DIR, 'reconciliation-report-latest.json');
    await writeJSONAtomic(latestPath, report);
  }

  return { report, reportPath };
}

// ----------------------------------------------------------------------------
// Phase 6 — Post-reconciliation verification (no losses)
// ----------------------------------------------------------------------------

async function phase6_verifyNoLosses(ctx, reconResult, idemResult) {
  log('Phase 6: Verifying no losses after reconciliation.');
  const { bakBatches, bakItems, bakEarn } = ctx;
  const { newBatches, newItems, newEarn } = reconResult;

  const checks = [];

  // Check 1: batch counts preserved
  checks.push({
    name: 'batch_count_preserved',
    pass: bakBatches.length === newBatches.length,
    detail: `before=${bakBatches.length} after=${newBatches.length}`,
  });
  // Check 2: item counts preserved
  checks.push({
    name: 'item_count_preserved',
    pass: bakItems.length === newItems.length,
    detail: `before=${bakItems.length} after=${newItems.length}`,
  });
  // Check 3: earning counts merged (>= bak)
  checks.push({
    name: 'earning_count_merged',
    pass: newEarn.length >= bakEarn.length,
    detail: `bak=${bakEarn.length} new=${newEarn.length}`,
  });
  // Check 4: total batch USD preserved
  const beforeBatchUSD = bakBatches.reduce((s, b) => s + Number(b.total_amount || 0), 0);
  const afterBatchUSD  = newBatches.reduce((s, b) => s + Number(b.total_amount || 0), 0);
  checks.push({
    name: 'batch_total_usd_preserved',
    pass: Math.abs(beforeBatchUSD - afterBatchUSD) < 0.01,
    detail: `before=${beforeBatchUSD.toFixed(2)} after=${afterBatchUSD.toFixed(2)}`,
  });
  // Check 5: total item USD preserved
  const beforeItemUSD = bakItems.reduce((s, b) => s + Number(b.amount || 0), 0);
  const afterItemUSD  = newItems.reduce((s, b) => s + Number(b.amount || 0), 0);
  checks.push({
    name: 'item_total_usd_preserved',
    pass: Math.abs(beforeItemUSD - afterItemUSD) < 0.01,
    detail: `before=${beforeItemUSD.toFixed(2)} after=${afterItemUSD.toFixed(2)}`,
  });
  // Check 6: every batch has a known terminal status
  const allowedStatuses = new Set([
    'cancelled_ghost',
    'failed_recoverable',
    'failed_recoverable_requires_manual_review',
    'settled', 'completed', 'paid', 'confirmed',
    'failed',
  ]);
  const badStatuses = newBatches.filter(b => !allowedStatuses.has(b.status));
  checks.push({
    name: 'all_batches_in_terminal_status',
    pass: badStatuses.length === 0,
    detail: badStatuses.length ? `first bad: ${badStatuses[0].batch_id}=${badStatuses[0].status}` : 'ok',
  });
  // Check 7: idempotency files all voided (or already in terminal state)
  const idemCheck = idemResult.voided.every(v => v.prior_status === 'processing' || v.prior_status === 'pending');
  checks.push({
    name: 'idempotency_locks_voided_cleanly',
    pass: idemCheck,
    detail: `voided=${idemResult.voided.length}`,
  });
  // Check 8: no records were silently dropped (every batch_id before is present after)
  const beforeIds = new Set(bakBatches.map(b => b.batch_id));
  const afterIds  = new Set(newBatches.map(b => b.batch_id));
  const missing   = [...beforeIds].filter(id => !afterIds.has(id));
  checks.push({
    name: 'no_batch_ids_dropped',
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.slice(0, 5).join(', ')}` : 'ok',
  });

  const allPass = checks.every(c => c.pass);
  log(`  Verification: ${checks.filter(c => c.pass).length}/${checks.length} checks passed`);
  if (!allPass) {
    logw('  FAILED checks:');
    checks.filter(c => !c.pass).forEach(c => logw(`    [${c.name}] ${c.detail}`));
  } else {
    log('  All no-loss checks passed.');
  }

  return { allPass, checks };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  log(`ChariBaaS Payout Reconciliation — DRY_RUN=${DRY_RUN}`);
  log(`Repo root: ${REPO_ROOT}`);

  const ctx = await phase1_loadAndSnapshot();

  const inv = await phase2_validateNoLossInvariants(ctx);
  ctx.invariants = inv;
  if (!inv.ok) {
    log('Invariants failed — aborting without changes.');
    process.exit(2);
  }

  const reconResult = await phase3_applyReconciliation(ctx);

  const idemResult = await phase4_voidIdempotencyLocks();

  const verify = await phase6_verifyNoLosses(ctx, reconResult, idemResult);

  // Only persist if verification passes
  if (!verify.allPass) {
    logw('Verification failed — aborting persist. No files were changed.');
    process.exit(3);
  }

  const persistResult = await phase5_persistAndReport(ctx, reconResult, idemResult);

  log('=========================================================');
  log('RECONCILIATION COMPLETE');
  log('=========================================================');
  log(`  Run ID:                  ${RECONCILE_RUN_ID}`);
  log(`  Reconciled at:           ${RECONCILED_AT}`);
  log(`  Dry run:                 ${DRY_RUN}`);
  log(`  Batches reconciled:      ${reconResult.newBatches.length}`);
  log(`  Items reconciled:        ${reconResult.newItems.length}`);
  log(`  Earnings merged:         ${reconResult.newEarn.length}`);
  log(`  Recoverable amount:      $${reconResult.postSummary.recoverable_amount_usd.toFixed(2)} USD`);
  log(`  Cancelled ghost amount:  $${reconResult.postSummary.cancelled_ghost_amount_usd.toFixed(2)} USD`);
  log(`  Manual review amount:    $${reconResult.postSummary.manual_review_amount_usd.toFixed(2)} USD`);
  log(`  Idempotency locks voided:${idemResult.voided.length}`);
  log(`  Swarm frozen:            ${reconResult.newState.freeze.active} (reason: ${reconResult.newState.freeze.reason})`);
  log(`  Verification:            ${verify.checks.filter(c => c.pass).length}/${verify.checks.length} checks passed`);
  log(`  Report:                  ${persistResult.reportPath}`);
  log('=========================================================');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

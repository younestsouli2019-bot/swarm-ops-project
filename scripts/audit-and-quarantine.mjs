#!/usr/bin/env bun
/**
 * ChariBaaS — Forensic Audit & Losses Recovery Quarantine
 *
 * Audits every economic-event entity across two data planes:
 *
 *   1. Base44 remote API (legacy phantom data)
 *      - RevenueEvent
 *      - PayoutBatch
 *      - PayoutItem
 *      - PayoutRecipient
 *
 *   2. In-memory settlement + procurement ledgers (live 2PC state)
 *      - Settlement Ledger entries (kind: revenue | procurement | payout)
 *      - Procurement Ledger PurchaseOrders + Invoices + Receipts
 *
 * Audit domains (per operator directive):
 *   A. OwnerSettlements    — fake tx hashes, fake PayPal IDs, fake bank refs
 *   B. CryptoSettlements   — misrouted funds to fake addresses
 *   C. PayoutBatches       — fabricated payouts
 *   D. PayoutItems         — fabricated payouts
 *   E. RevenueEvents       — fabricated revenue
 *   F. OwnerPayments       — routing to fake bank/crypto accounts
 *   G. ProcurementItem/PO/Shipment state machine integrity
 *
 * Quarantine action per finding:
 *   - Base44 entities: PUT with status="quarantined" (or "failed" for PayoutItem),
 *     error_message="AUDIT QUARANTINE: <reason>", metadata.audit_quarantined_at,
 *     metadata.audit_reason, metadata.audit_severity.
 *   - In-memory ledger entries: fail() with reason "audit quarantine: <reason>".
 *   - In-memory POs: failPO() with reason "audit quarantine: <reason>".
 *
 * Output:
 *   - /home/z/my-project/download/audit-report.json   (full findings + quarantine actions)
 *   - /home/z/my-project/download/audit-report.md     (human-readable summary)
 *   - stdout: progress + final summary
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ─── Base44 client ────────────────────────────────────────────────────────
const B44_BASE = "https://agent-swarm-efe0bd7e.base44.app/api";
const B44_KEY = process.env.BASE44_API_KEY;
if (!B44_KEY) {
  console.error("ERROR: BASE44_API_KEY env var is not set. Set it in .env or export it.");
  process.exit(1);
}

async function b44List(entity, limit = 500, skip = 0) {
  const url = `${B44_BASE}/entities/${entity}?limit=${limit}&skip=${skip}`;
  const res = await fetch(url, {
    headers: { api_key: B44_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`b44.list ${entity} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function b44ListAll(entity) {
  const all = [];
  let skip = 0;
  // Page until we get fewer than 500 or hit 50 pages (25,000 records max).
  for (let page = 0; page < 50; page++) {
    const batch = await b44List(entity, 500, skip);
    if (!Array.isArray(batch)) return all;
    all.push(...batch);
    if (batch.length < 500) return all;
    skip += 500;
  }
  return all;
}

async function b44Update(entity, id, patch) {
  const url = `${B44_BASE}/entities/${entity}/${id}`;
  // Base44 rate-limits at ~1 req/sec. Strategy:
  //   - 429: short fixed wait (1.2s), retry quickly. Up to 15 attempts.
  //   - 5xx: exponential backoff (1s, 2s, 4s ...). Up to 6 attempts.
  //   - other 4xx: non-retryable, throw.
  const MAX_429_RETRIES = 15;
  const MAX_5XX_RETRIES = 6;
  let lastErr = null;
  let attempts429 = 0;
  let attempts5xx = 0;
  while (true) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { api_key: B44_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.json();
      const text = await res.text();
      if (res.status === 429) {
        attempts429++;
        if (attempts429 > MAX_429_RETRIES) {
          throw new Error(`b44.update ${entity}/${id} -> 429 (exhausted ${MAX_429_RETRIES} retries): ${text.slice(0, 200)}`);
        }
        // Short fixed wait — rate limit is per-second.
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      if (res.status >= 500) {
        attempts5xx++;
        if (attempts5xx > MAX_5XX_RETRIES) {
          throw new Error(`b44.update ${entity}/${id} -> ${res.status} (exhausted ${MAX_5XX_RETRIES} retries): ${text.slice(0, 200)}`);
        }
        const delayMs = Math.min(32_000, 1000 * 2 ** (attempts5xx - 1));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Non-retryable 4xx
      throw new Error(`b44.update ${entity}/${id} -> ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      // Network/timeout — retry up to 3 times with 2s wait
      if (err.message && err.message.includes("-> ")) {
        throw err; // Already formatted HTTP error — re-throw
      }
      attempts5xx++;
      if (attempts5xx > MAX_5XX_RETRIES) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ─── In-memory ledger (via local Next.js dev server) ─────────────────────
async function fetchLedgerState() {
  try {
    const res = await fetch("http://localhost:3000/api/settlement-ledger?audit=1&events=1", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Audit rule helpers ──────────────────────────────────────────────────

const SHA256_RE = /^[a-f0-9]{64}$/;
const PAYPAL_TX_RE = /^PAYID-[A-Z0-9]{17,}$/;          // real PayPal payout IDs
const STRIPI_CH_RE = /^(ch|pi|txn|re)_[A-Za-z0-9]{14,}$/; // real Stripe ids
const ACH_TRACE_RE = /^[A-Z0-9]{8,22}$/;               // ACH trace numbers (no txn_ prefix)

// Real BTC address (P2PKH / P2SH / Bech32)
const BTC_ADDR_RE =
  /^(bc1[qz][a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
// Real ETH/USDT (ERC-20) address — 0x + 40 hex
const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
// Real Solana address — base58, 32-44 chars
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Reserved / fake TLDs that should never appear in a real bank account email
const FAKE_EMAIL_TLDS = /\.(example|test|invalid|localhost|local|sample|demo|fake)$/;
const FAKE_EMAIL_LOCALPART = /^(operator|test|demo|fake|sample|placeholder|noreply|foo|bar)[@+]/i;

function isFakeEmail(s) {
  if (typeof s !== "string") return false;
  if (FAKE_EMAIL_TLDS.test(s)) return true;
  if (FAKE_EMAIL_LOCALPART.test(s)) return true;
  return false;
}

function isFakeCryptoAddress(addr, currency) {
  if (typeof addr !== "string" || addr.length === 0) return true;
  const c = String(currency || "").toUpperCase();
  if (c === "BTC") return !BTC_ADDR_RE.test(addr);
  if (c === "ETH" || c === "USDT" || c === "USDC") return !ETH_ADDR_RE.test(addr);
  if (c === "SOL") return !SOL_ADDR_RE.test(addr);
  // Unknown currency: must match at least one canonical format
  return !(BTC_ADDR_RE.test(addr) || ETH_ADDR_RE.test(addr) || SOL_ADDR_RE.test(addr));
}

function isFakeTxHash(s) {
  if (typeof s !== "string") return true;
  if (s.length === 0) return true;
  // Internal fabrications: txn_<random>, sim_<hex>, REV-<hex>, PB-<hex>, PI-<hex>
  if (/^(txn_|sim_|REV-|PB-|PI-|fake_|test_)/.test(s)) return true;
  // Real on-chain hashes are 64-char hex
  if (SHA256_RE.test(s)) return false;
  // PayPal / Stripe / ACH forms
  if (PAYPAL_TX_RE.test(s)) return false;
  if (STRIPI_CH_RE.test(s)) return false;
  if (ACH_TRACE_RE.test(s)) return false;
  // Anything else is suspect
  return true;
}

function isFakeEventHash(s) {
  if (typeof s !== "string" || s.length === 0) return true;
  // Real: 64-char hex (sha256)
  if (SHA256_RE.test(s)) return false;
  // Fabricated by orchestrator.ts line 858: `${task.id}|${hit_id}|${totalReward}`
  if (s.includes("|")) return true;
  // Any other non-hex string is fake
  return true;
}

function isFakeBankRef(s) {
  if (typeof s !== "string") return false;
  // Fake routing numbers: all zeros, sequential, or clearly placeholder
  if (/^0+$/.test(s)) return true;
  if (/^123456789$/.test(s)) return true;
  if (/^0000/.test(s)) return true;
  return false;
}

// ─── Finding model ───────────────────────────────────────────────────────

let findingSeq = 0;
function makeFinding(domain, severity, entity, id, ref, issue, detail, evidence = {}) {
  findingSeq += 1;
  return {
    finding_id: `FIND-${String(findingSeq).padStart(4, "0")}`,
    domain,
    severity, // "critical" | "warning" | "info"
    entity,
    entity_id: id,
    external_ref: ref,
    issue,
    detail,
    evidence,
    quarantine_action: null, // filled by quarantine pass
  };
}

// ─── Domain A: OwnerSettlements ──────────────────────────────────────────
//
// Map: PayoutItem rows where recipient_name matches /operator|owner/i OR
// recipient matches the default owner-attached account. Detect:
//   - external_transaction_id that's a fake/internal format (txn_*, REV-*, empty)
//   - recipient that's a fake email (.example / .test / operator@)
//   - processed_at missing despite status="success"

// Skip records already quarantined by a prior audit pass.
function isAlreadyQuarantined(rec) {
  const meta = (rec && rec.metadata) || {};
  if (meta.audit_quarantined === true) return true;
  // PayoutRecipient schema has no metadata field — check notes instead.
  const notes = String((rec && rec.notes) || "");
  if (notes.includes("AUDIT QUARANTINE")) return true;
  return false;
}

// Skip records in a terminal/quarantined status — they've already been dealt with.
function isTerminalStatus(entity, status) {
  const s = String(status || "").toLowerCase();
  if (entity === "RevenueEvent") return s === "failed" || s === "cancelled";
  if (entity === "PayoutItem")    return s === "failed" || s === "refunded";
  if (entity === "PayoutBatch")   return s === "failed" || s === "cancelled";
  return false;
}

function auditOwnerSettlements(payoutItems, recipients) {
  const findings = [];
  const ownerRecipientIds = new Set(
    recipients
      .filter((r) => /operator|owner/i.test(String(r.name || "")))
      .map((r) => r.account_identifier)
  );
  for (const pi of payoutItems) {
    if (isAlreadyQuarantined(pi) || isTerminalStatus("PayoutItem", pi.status)) continue;
    const isOwner =
      ownerRecipientIds.has(String(pi.recipient)) ||
      /operator|owner/i.test(String(pi.recipient_name || "")) ||
      /operator|owner/i.test(String(pi.recipient || ""));
    if (!isOwner) continue;

    // Fake PayPal ID / external tx id
    if (pi.status === "success") {
      const extId = String(pi.external_transaction_id || "");
      if (isFakeTxHash(extId)) {
        findings.push(
          makeFinding(
            "OwnerSettlements",
            "critical",
            "PayoutItem",
            pi.id,
            pi.item_id || pi.id,
            "Owner payout marked success with fake external_transaction_id",
            `external_transaction_id="${extId}" does not match any real PayPal/Stripe/ACH/on-chain format. Internal txn_* ids are fabricated by orchestrator.ts:974 and are not bank-confirmed.`,
            { external_transaction_id: extId, recipient: pi.recipient, amount: pi.amount }
          )
        );
      }
      if (!pi.processed_at) {
        findings.push(
          makeFinding(
            "OwnerSettlements",
            "warning",
            "PayoutItem",
            pi.id,
            pi.item_id || pi.id,
            "Owner payout success without processed_at timestamp",
            "A real bank/PayPal confirmation always carries a timestamp. Missing processed_at means the success flag was self-asserted.",
            { status: pi.status, recipient: pi.recipient }
          )
        );
      }
    }
    // Fake recipient email
    if (isFakeEmail(String(pi.recipient || ""))) {
      findings.push(
        makeFinding(
          "OwnerSettlements",
          "critical",
          "PayoutItem",
          pi.id,
          pi.item_id || pi.id,
          "Owner payout routed to fake email domain",
          `recipient="${pi.recipient}" uses a reserved TLD (.example/.test/.invalid) or placeholder local-part. Real operator bank accounts cannot be reached at these domains.`,
          { recipient: pi.recipient, recipient_type: pi.recipient_type }
        )
      );
    }
  }
  return findings;
}

// ─── Domain B: CryptoSettlements ─────────────────────────────────────────
//
// Map: PayoutItem rows where recipient_type="crypto_wallet" AND settlement
// ledger entries with rail="chainlink" or currency in {BTC, ETH, USDT, USDC, SOL}.
// Detect:
//   - recipient wallet address that doesn't match canonical format for the currency
//   - external_transaction_id that's not a real on-chain hash (64-char hex)
//   - misrouted funds: wallet address appears in multiple recipients (sink address)

function auditCryptoSettlements(payoutItems, recipients, ledgerEntries) {
  const findings = [];
  const walletToRecipients = new Map(); // wallet -> Set<recipient_id>

  // Build wallet → recipient map (catches misrouting where one wallet is attached to multiple names)
  for (const r of recipients) {
    if (r.recipient_type === "crypto_wallet") {
      const addr = String(r.account_identifier || "");
      if (!walletToRecipients.has(addr)) walletToRecipients.set(addr, new Set());
      walletToRecipients.get(addr).add(String(r.id || r.name || ""));
    }
  }

  for (const pi of payoutItems) {
    if (isAlreadyQuarantined(pi) || isTerminalStatus("PayoutItem", pi.status)) continue;
    if (pi.recipient_type !== "crypto_wallet") continue;
    const addr = String(pi.recipient || "");
    const cur = String(pi.currency || "").toUpperCase();
    if (isFakeCryptoAddress(addr, cur)) {
      findings.push(
        makeFinding(
          "CryptoSettlements",
          "critical",
          "PayoutItem",
          pi.id,
          pi.item_id || pi.id,
          `Crypto payout routed to malformed ${cur || "(unknown)"} wallet address`,
          `recipient="${addr}" does not match the canonical format for ${cur || "any supported chain"}. Funds sent here are unrecoverable.`,
          { recipient: addr, currency: pi.currency, amount: pi.amount }
        )
      );
    }
    if (pi.status === "success") {
      const txid = String(pi.external_transaction_id || "");
      if (!SHA256_RE.test(txid)) {
        findings.push(
          makeFinding(
            "CryptoSettlements",
            "critical",
            "PayoutItem",
            pi.id,
            pi.item_id || pi.id,
            "Crypto payout marked success without a real on-chain transaction hash",
            `external_transaction_id="${txid}" is not a 64-char hex on-chain hash. Real blockchain confirmations always produce one.`,
            { external_transaction_id: txid, recipient: addr }
          )
        );
      }
    }
    // Misrouting: same wallet appears on multiple recipient records
    const attached = walletToRecipients.get(addr);
    if (attached && attached.size > 1) {
      findings.push(
        makeFinding(
          "CryptoSettlements",
          "warning",
          "PayoutItem",
          pi.id,
          pi.item_id || pi.id,
          "Crypto wallet shared across multiple recipient records (potential misrouting sink)",
          `Wallet ${addr.slice(0, 12)}… is attached to ${attached.size} recipient records: ${[...attached].slice(0, 5).join(", ")}.`,
          { wallet: addr, attached_count: attached.size }
        )
      );
    }
  }

  // Also check settlement-ledger entries with chainlink rail (live 2PC state)
  for (const e of ledgerEntries || []) {
    if (e.rail !== "chainlink" && !/BTC|ETH|USDT|USDC|SOL/i.test(String(e.currency || ""))) continue;
    const cp = String(e.counterparty_id || "");
    if (isFakeCryptoAddress(cp, e.currency)) {
      findings.push(
        makeFinding(
          "CryptoSettlements",
          "critical",
          "LedgerEntry",
          e.id,
          e.external_ref,
          "Settlement ledger entry routes to malformed crypto counterparty",
          `counterparty_id="${cp}" does not match canonical ${e.currency} format.`,
          { counterparty_id: cp, currency: e.currency, state: e.state }
        )
      );
    }
    if (e.state === "SETTLED" && !SHA256_RE.test(String(e.receipt_hash || ""))) {
      findings.push(
        makeFinding(
          "CryptoSettlements",
          "critical",
          "LedgerEntry",
          e.id,
          e.external_ref,
          "SETTLED crypto entry has non-cryptographic receipt_hash",
          `receipt_hash="${e.receipt_hash}" is not a 64-char hex. Hard rule violation.`,
          { receipt_hash: e.receipt_hash }
        )
      );
    }
  }
  return findings;
}

// ─── Domains C+D: PayoutBatches + PayoutItems ────────────────────────────

function auditPayoutBatches(batches, items) {
  const findings = [];
  const itemsByBatch = new Map();
  for (const it of items) {
    const k = String(it.batch_id || "");
    if (!itemsByBatch.has(k)) itemsByBatch.set(k, []);
    itemsByBatch.get(k).push(it);
  }
  for (const b of batches) {
    if (isAlreadyQuarantined(b) || isTerminalStatus("PayoutBatch", b.status)) continue;
    const bItems = itemsByBatch.get(String(b.id)) || [];
    const sum = bItems.reduce((s, it) => s + Number(it.amount || 0), 0);
    const batchTotal = Number(b.total_amount || 0);
    // Status="approved" or "completed" but no processed_at
    if ((b.status === "approved" || b.status === "completed") && !b.processed_at) {
      findings.push(
        makeFinding(
          "PayoutBatches",
          "warning",
          "PayoutBatch",
          b.id,
          b.batch_id || b.id,
          `PayoutBatch status="${b.status}" but processed_at is null`,
          "Batch claims to be approved/completed without a processing timestamp. Real payment rails always stamp a settlement time.",
          { status: b.status, total_amount: batchTotal }
        )
      );
    }
    // Status="completed" but no items
    if (b.status === "completed" && bItems.length === 0) {
      findings.push(
        makeFinding(
          "PayoutBatches",
          "critical",
          "PayoutBatch",
          b.id,
          b.batch_id || b.id,
          "PayoutBatch marked completed with zero items",
          "A completed batch must contain at least one PayoutItem. An empty completed batch is fabricated.",
          { status: b.status, item_count: b.item_count, actual_items: 0 }
        )
      );
    }
    // Total mismatch
    if (bItems.length > 0 && Math.abs(sum - batchTotal) > 0.01) {
      findings.push(
        makeFinding(
          "PayoutBatches",
          "critical",
          "PayoutBatch",
          b.id,
          b.batch_id || b.id,
          "PayoutBatch total_amount does not match sum of items",
          `Batch total=${batchTotal.toFixed(2)}, but sum of ${bItems.length} items=${sum.toFixed(2)}. Δ=${(sum - batchTotal).toFixed(2)}.`,
          { batch_total: batchTotal, items_sum: sum, item_count: bItems.length }
        )
      );
    }
    // revenue_event_ids empty (broken linkage)
    if (Array.isArray(b.revenue_event_ids) && b.revenue_event_ids.length === 0) {
      findings.push(
        makeFinding(
          "PayoutBatches",
          "warning",
          "PayoutBatch",
          b.id,
          b.batch_id || b.id,
          "PayoutBatch has no linked RevenueEvents",
          "revenue_event_ids=[] — batch is disconnected from any revenue source. Could indicate fabricated payout.",
          { status: b.status, total_amount: batchTotal }
        )
      );
    }
  }
  return findings;
}

function auditPayoutItems(items) {
  const findings = [];
  for (const it of items) {
    if (isAlreadyQuarantined(it) || isTerminalStatus("PayoutItem", it.status)) continue;
    // success with no external_transaction_id
    if (it.status === "success" && !it.external_transaction_id) {
      findings.push(
        makeFinding(
          "PayoutItems",
          "critical",
          "PayoutItem",
          it.id,
          it.item_id || it.id,
          "PayoutItem marked success with no external_transaction_id",
          "A successful payout must carry the rail's confirmation id. Empty external_transaction_id = fabricated success.",
          { status: it.status, amount: it.amount, recipient: it.recipient }
        )
      );
    }
    // success with fake external_transaction_id
    if (it.status === "success" && it.external_transaction_id && isFakeTxHash(String(it.external_transaction_id))) {
      // Skip if already flagged by OwnerSettlements (same entity)
      // We'll deduplicate at the end.
      findings.push(
        makeFinding(
          "PayoutItems",
          "critical",
          "PayoutItem",
          it.id,
          it.item_id || it.id,
          "PayoutItem marked success with fabricated external_transaction_id",
          `external_transaction_id="${it.external_transaction_id}" is internal-format (txn_*/REV-*/PB-*/PI-*). Real rails return PayPal PAYID-*, Stripe ch_/pi_, or on-chain hashes.`,
          { external_transaction_id: it.external_transaction_id, recipient_type: it.recipient_type }
        )
      );
    }
    // refunded with no error_message
    if (it.status === "refunded" && !it.error_message) {
      findings.push(
        makeFinding(
          "PayoutItems",
          "warning",
          "PayoutItem",
          it.id,
          it.item_id || it.id,
          "PayoutItem refunded with no error_message",
          "Refunds always carry a reason from the rail. Missing error_message = self-asserted refund.",
          { status: it.status }
        )
      );
    }
  }
  return findings;
}

// ─── Domain E: RevenueEvents ─────────────────────────────────────────────

function auditRevenueEvents(events) {
  const findings = [];
  for (const ev of events) {
    if (isAlreadyQuarantined(ev) || isTerminalStatus("RevenueEvent", ev.status)) continue;
    // Fake event_hash (the smoking gun)
    if (isFakeEventHash(String(ev.event_hash || ""))) {
      findings.push(
        makeFinding(
          "RevenueEvents",
          "critical",
          "RevenueEvent",
          ev.id,
          ev.event_id || ev.id,
          "RevenueEvent carries a fabricated event_hash",
          `event_hash="${ev.event_hash}" is not a 64-char sha256 hex. Orchestrator.ts:858 builds it as \`${ev.source_id || "<source_id>"}|${(ev.metadata && ev.metadata.hit_id) || "<hit_id>"}|${ev.amount * 100}\` — a concatenation, not a cryptographic hash. The event is therefore not externally attested.`,
          { event_hash: ev.event_hash, source: ev.source, amount: ev.amount }
        )
      );
    }
    // status="confirmed" with no confirmation_date
    if (ev.status === "confirmed" && !ev.confirmation_date) {
      findings.push(
        makeFinding(
          "RevenueEvents",
          "warning",
          "RevenueEvent",
          ev.id,
          ev.event_id || ev.id,
          "RevenueEvent confirmed without confirmation_date",
          "Confirmed status requires an external confirmation timestamp. Missing = self-confirmed.",
          { status: ev.status }
        )
      );
    }
    // status="paid_out" with no external_confirmation_ref in metadata
    const meta = (ev.metadata || {});
    if (ev.status === "paid_out" && !meta.external_confirmation_ref) {
      findings.push(
        makeFinding(
          "RevenueEvents",
          "critical",
          "RevenueEvent",
          ev.id,
          ev.event_id || ev.id,
          "RevenueEvent marked paid_out with no external_confirmation_ref",
          "Paid-out status requires an external bank/PayPal/on-chain reference in metadata.external_confirmation_ref. Missing = self-settled (Echo-Chamber Consensus anti-pattern).",
          { status: ev.status, payout_batch_id: ev.payout_batch_id }
        )
      );
    }
    // source="manual_entry" with amount > $0
    if (ev.source === "manual_entry" && Number(ev.amount || 0) > 0) {
      findings.push(
        makeFinding(
          "RevenueEvents",
          "warning",
          "RevenueEvent",
          ev.id,
          ev.event_id || ev.id,
          "RevenueEvent source=manual_entry with non-zero amount",
          "Manual entries should never carry economic weight without an external oracle witness.",
          { source: ev.source, amount: ev.amount }
        )
      );
    }
  }
  return findings;
}

// ─── Domain F: OwnerPayments (PayoutRecipients) ──────────────────────────

function auditOwnerPayments(recipients) {
  const findings = [];
  for (const r of recipients) {
    if (isAlreadyQuarantined(r)) continue;
    const isOwner = /operator|owner/i.test(String(r.name || ""));
    if (!isOwner) continue;

    // PayPal email with fake domain
    if (r.recipient_type === "paypal_email" && isFakeEmail(String(r.account_identifier || ""))) {
      findings.push(
        makeFinding(
          "OwnerPayments",
          "critical",
          "PayoutRecipient",
          r.id,
          r.name,
          "Owner PayPal recipient uses fake email domain",
          `account_identifier="${r.account_identifier}" — reserved TLD or placeholder local-part. Payouts routed here are unservicable.`,
          { account_identifier: r.account_identifier, recipient_type: r.recipient_type }
        )
      );
    }
    // Bank account with fake routing number
    if (r.recipient_type === "bank_account" && isFakeBankRef(String(r.routing_number || ""))) {
      findings.push(
        makeFinding(
          "OwnerPayments",
          "critical",
          "PayoutRecipient",
          r.id,
          r.name,
          "Owner bank account has fake/placeholder routing_number",
          `routing_number="${r.routing_number}" — all-zero or sequential test number. Real ACH routing numbers are 9-digit MICR codes registered with ABA.`,
          { routing_number: r.routing_number, bank_name: r.bank_name }
        )
      );
    }
    // Crypto wallet with fake address
    if (r.recipient_type === "crypto_wallet" && isFakeCryptoAddress(String(r.account_identifier || ""), r.currency)) {
      findings.push(
        makeFinding(
          "OwnerPayments",
          "critical",
          "PayoutRecipient",
          r.id,
          r.name,
          `Owner ${r.currency || "(unknown)"} wallet is a malformed address`,
          `account_identifier="${r.account_identifier}" does not match canonical ${r.currency || "any chain"} format. Funds sent here are unrecoverable.`,
          { account_identifier: r.account_identifier, currency: r.currency }
        )
      );
    }
    // Missing bank_name for bank_account
    if (r.recipient_type === "bank_account" && !r.bank_name) {
      findings.push(
        makeFinding(
          "OwnerPayments",
          "warning",
          "PayoutRecipient",
          r.id,
          r.name,
          "Owner bank_account with no bank_name",
          "Bank account recipient missing bank_name — cannot verify the institution.",
          { account_identifier: r.account_identifier }
        )
      );
    }
  }
  return findings;
}

// ─── Domain G: Procurement state machine integrity ───────────────────────

function auditProcurementState(pos, invoices, receipts, ledgerState) {
  const findings = [];
  const validTransitions = {
    Draft_Speculative: ["Supplier_Acknowledged", "Cancelled", "Failed"],
    Supplier_Acknowledged: ["Shipment_Pending", "Cancelled", "Failed"],
    Shipment_Pending: ["In_Transit", "Cancelled", "Failed"],
    In_Transit: ["Received_Verified", "Failed"],
    Received_Verified: [],
    Cancelled: [],
    Failed: [],
  };

  for (const po of pos) {
    // Invalid state value
    if (!validTransitions[po.state]) {
      findings.push(
        makeFinding(
          "Procurement",
          "critical",
          "PurchaseOrder",
          po.id,
          po.po_number || po.id,
          `PO has invalid state "${po.state}"`,
          "State is outside the strict POState enum. Schema violation.",
          { state: po.state }
        )
      );
      continue;
    }
    // Received_Verified without three_way_match
    if (po.state === "Received_Verified" && !po.three_way_match) {
      findings.push(
        makeFinding(
          "Procurement",
          "critical",
          "PurchaseOrder",
          po.id,
          po.po_number || po.id,
          "PO reached Received_Verified without a three_way_match result",
          "Receipt verification requires a passed three-way match (PO + Invoice + Receiving Receipt). Missing match = self-asserted receipt.",
          { state: po.state, supplier_id: po.supplier_id }
        )
      );
    }
    // Received_Verified without settlement_entry_id
    if (po.state === "Received_Verified" && !po.settlement_entry_id) {
      findings.push(
        makeFinding(
          "Procurement",
          "critical",
          "PurchaseOrder",
          po.id,
          po.po_number || po.id,
          "PO reached Received_Verified without bridging to the settlement ledger",
          "Every Received_Verified PO must create a SETTLED procurement entry. Missing bridge = economic weight recorded outside the 2PC ledger.",
          { state: po.state }
        )
      );
    }
    // In_Transit without carrier scan
    if (po.state === "In_Transit" && !po.last_carrier_scan) {
      findings.push(
        makeFinding(
          "Procurement",
          "critical",
          "PurchaseOrder",
          po.id,
          po.po_number || po.id,
          "PO reached In_Transit without a verified CarrierScanEvent",
          "Zero-trust carrier tracking requires the carrier's own API to confirm physical possession. Missing scan = supplier self-reported shipment.",
          { state: po.state, carrier: po.carrier, tracking_number: po.tracking_number }
        )
      );
    }
    // Shipment_Pending without tracking_number
    if (po.state === "Shipment_Pending" && !po.tracking_number) {
      findings.push(
        makeFinding(
          "Procurement",
          "warning",
          "PurchaseOrder",
          po.id,
          po.po_number || po.id,
          "PO in Shipment_Pending without a tracking_number",
          "Shipment_Pending requires a carrier tracking number. Missing = state advanced without logistics proof.",
          { state: po.state, carrier: po.carrier }
        )
      );
    }
  }

  // Ledger entries of kind="procurement" cross-check
  const ledgerEntries = (ledgerState && ledgerState.entries_recent) || [];
  for (const e of ledgerEntries) {
    if (e.kind !== "procurement") continue;
    if (e.state === "SETTLED" && !e.receipt_hash) {
      findings.push(
        makeFinding(
          "Procurement",
          "critical",
          "LedgerEntry",
          e.id,
          e.external_ref,
          "Procurement ledger entry SETTLED without receipt_hash",
          "Hard rule violation: every Settled entry must carry an oracle receipt hash.",
          { state: e.state, amount_cents: e.amount_cents }
        )
      );
    }
  }

  return findings;
}

// ─── Quarantine execution ────────────────────────────────────────────────

async function quarantineBase44(entity, id, finding, currentMeta) {
  // PayoutRecipient schema has no `metadata` field — use `notes` instead.
  if (entity === "PayoutRecipient") {
    const patch = {
      notes: `AUDIT QUARANTINE [${finding.finding_id}]: ${finding.issue} (quarantined at ${new Date().toISOString()})`,
      is_default: false, // demote so future payouts don't auto-select this recipient
    };
    try {
      await b44Update(entity, id, patch);
      return { ok: true, action: "quarantined_via_notes", patch };
    } catch (err) {
      return { ok: false, error: err.message, patch };
    }
  }
  const patch = {
    status: "failed",
    error_message: `AUDIT QUARANTINE [${finding.finding_id}]: ${finding.issue}`,
    metadata: {
      ...(currentMeta || {}),
      audit_quarantined: true,
      audit_quarantined_at: new Date().toISOString(),
      audit_reason: finding.issue,
      audit_severity: finding.severity,
      audit_domain: finding.domain,
      audit_finding_id: finding.finding_id,
    },
  };
  try {
    await b44Update(entity, id, patch);
    return { ok: true, action: "quarantined", patch };
  } catch (err) {
    return { ok: false, error: err.message, patch };
  }
}

async function quarantineLedgerEntry(entryId, finding) {
  try {
    const res = await fetch("http://localhost:3000/api/settlement-ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "fail",
        entry_id: entryId,
        actor: "audit-quarantine-bot",
        reason: `AUDIT QUARANTINE [${finding.finding_id}]: ${finding.issue}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    return { ok: !!j.ok, action: "failed", response: j };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function quarantinePO(poId, finding) {
  try {
    const res = await fetch("http://localhost:3000/api/settlement-ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "fail_po",
        po_id: poId,
        actor: "audit-quarantine-bot",
        reason: `AUDIT QUARANTINE [${finding.finding_id}]: ${finding.issue}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    return { ok: !!j.ok, action: "failed_po", response: j };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes("--dry-run") || !args.includes("--apply");
  const SKIP_QUARANTINE = args.includes("--audit-only");
  const RESUME = args.includes("--resume");

  // Resume mode: load previous audit report and skip records that already succeeded.
  let resumeSkip = new Set();
  if (RESUME) {
    try {
      const prev = JSON.parse(
        await Bun.file("/home/z/my-project/download/audit-report.json").text()
      );
      for (const a of (prev.quarantine_actions || [])) {
        if (a.ok) resumeSkip.add(`${a.entity}|${a.entity_id}`);
      }
      console.log(`Resume mode: skipping ${resumeSkip.size} already-quarantined records.`);
    } catch {
      console.log("Resume mode: no prior report found, starting fresh.");
    }
  }

  console.log("─".repeat(72));
  console.log("ChariBaaS Forensic Audit & Losses Recovery Quarantine");
  console.log("Mode:", DRY_RUN ? "DRY-RUN (no writes)" : "APPLY (will quarantine fakes)");
  console.log("Audit-only:", SKIP_QUARANTINE, " Resume:", RESUME);
  console.log("─".repeat(72));

  // ── 1. Pull all Base44 entities ──
  console.log("\n[1/4] Pulling Base44 entities…");
  const [revenueEvents, payoutBatches, payoutItems, payoutRecipients] = await Promise.all([
    b44ListAll("RevenueEvent"),
    b44ListAll("PayoutBatch"),
    b44ListAll("PayoutItem"),
    b44ListAll("PayoutRecipient"),
  ]);
  console.log(`  RevenueEvents:   ${revenueEvents.length}`);
  console.log(`  PayoutBatches:   ${payoutBatches.length}`);
  console.log(`  PayoutItems:     ${payoutItems.length}`);
  console.log(`  PayoutRecipients:${payoutRecipients.length}`);

  // ── 2. Pull in-memory ledger state ──
  console.log("\n[2/4] Pulling in-memory settlement + procurement ledger…");
  const ledgerState = await fetchLedgerState();
  if (!ledgerState) {
    console.log("  (no dev server response — assuming empty ledger)");
  } else {
    console.log(`  Ledger entries:  ${ledgerState.stats.total_entries}`);
    console.log(`  Procurement POs: ${ledgerState.procurement_stats.total_pos}`);
    console.log(`  Existing audit findings: ${(ledgerState.audit_findings || []).length}`);
  }

  const ledgerEntries = (ledgerState && ledgerState.entries_recent) || [];
  const ledgerPOs = (ledgerState && ledgerState.pos_recent) || [];

  // ── 3. Run all 6 audit domains ──
  console.log("\n[3/4] Running 6-domain audit…");
  const findings = [];
  findings.push(...auditOwnerSettlements(payoutItems, payoutRecipients));
  findings.push(...auditCryptoSettlements(payoutItems, payoutRecipients, ledgerEntries));
  findings.push(...auditPayoutBatches(payoutBatches, payoutItems));
  findings.push(...auditPayoutItems(payoutItems));
  findings.push(...auditRevenueEvents(revenueEvents));
  findings.push(...auditOwnerPayments(payoutRecipients));
  findings.push(...auditProcurementState(ledgerPOs, [], [], ledgerState));

  // Deduplicate findings by (entity, entity_id, issue) — multiple domains may flag the same record
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const key = `${f.entity}|${f.entity_id}|${f.issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // Sort: critical first
  const severityRank = { critical: 0, warning: 1, info: 2 };
  deduped.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  // Per-domain summary
  const byDomain = {};
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const f of deduped) {
    byDomain[f.domain] = (byDomain[f.domain] || 0) + 1;
    bySeverity[f.severity]++;
  }
  console.log("\n  Findings by domain:");
  for (const [d, n] of Object.entries(byDomain)) console.log(`    ${d.padEnd(22)} ${n}`);
  console.log("\n  Findings by severity:");
  console.log(`    critical: ${bySeverity.critical}`);
  console.log(`    warning:  ${bySeverity.warning}`);
  console.log(`    info:     ${bySeverity.info}`);

  // Compute economic exposure
  let criticalExposureCents = 0;
  let warningExposureCents = 0;
  const exposureByEntity = {};
  for (const f of deduped) {
    // Find amount from evidence
    let amountCents = 0;
    if (f.entity === "PayoutItem") {
      const pi = payoutItems.find((x) => x.id === f.entity_id);
      if (pi) amountCents = Math.round(Number(pi.amount || 0) * 100);
    } else if (f.entity === "PayoutBatch") {
      const pb = payoutBatches.find((x) => x.id === f.entity_id);
      if (pb) amountCents = Math.round(Number(pb.total_amount || 0) * 100);
    } else if (f.entity === "RevenueEvent") {
      const ev = revenueEvents.find((x) => x.id === f.entity_id);
      if (ev) amountCents = Math.round(Number(ev.amount || 0) * 100);
    } else if (f.entity === "LedgerEntry") {
      const le = ledgerEntries.find((x) => x.id === f.entity_id);
      if (le) amountCents = Number(le.amount_cents || 0);
    }
    exposureByEntity[f.entity] = (exposureByEntity[f.entity] || 0) + amountCents;
    if (f.severity === "critical") criticalExposureCents += amountCents;
    else if (f.severity === "warning") warningExposureCents += amountCents;
  }
  console.log(`\n  Economic exposure (sum of flagged amounts):`);
  console.log(`    critical: $${(criticalExposureCents / 100).toFixed(2)}`);
  console.log(`    warning:  $${(warningExposureCents / 100).toFixed(2)}`);

  // ── 4. Quarantine ──
  console.log("\n[4/4] Quarantine pass…");
  if (SKIP_QUARANTINE) {
    console.log("  --audit-only: skipping quarantine.");
  } else if (DRY_RUN) {
    console.log("  DRY-RUN: would quarantine the following records (no writes performed).");
  }

  // Group findings by (entity, entity_id) so we only update each record once.
  // Use the most severe finding as the canonical reason; collect all finding_ids.
  const byEntity = new Map();
  for (const f of deduped) {
    if (f.severity === "info") continue;
    const key = `${f.entity}|${f.entity_id}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, {
        entity: f.entity,
        entity_id: f.entity_id,
        findings: [],
        worst: f,
      });
    }
    const bucket = byEntity.get(key);
    bucket.findings.push(f);
    // critical > warning
    if (f.severity === "critical" && bucket.worst.severity !== "critical") {
      bucket.worst = f;
    }
  }
  const uniqueRecords = Array.from(byEntity.values());
  // In resume mode, filter out records that already succeeded.
  const filteredRecords = RESUME
    ? uniqueRecords.filter((r) => !resumeSkip.has(`${r.entity}|${r.entity_id}`))
    : uniqueRecords;
  console.log(`  Unique records to quarantine: ${filteredRecords.length} (from ${deduped.length} findings${RESUME ? `, ${uniqueRecords.length - filteredRecords.length} already done` : ""})`);

  const quarantineActions = [];

  if (DRY_RUN || SKIP_QUARANTINE) {
    for (const rec of filteredRecords) {
      for (const f of rec.findings) {
        quarantineActions.push({
          finding_id: f.finding_id,
          entity: rec.entity,
          entity_id: rec.entity_id,
          action: rec.entity === "LedgerEntry" ? "would_fail" : rec.entity === "PurchaseOrder" ? "would_fail_po" : "would_quarantine",
          dry_run: true,
        });
        f.quarantine_action = quarantineActions[quarantineActions.length - 1];
      }
    }
  } else {
    // Build update tasks for parallel execution.
    // Base44 rate-limits at ~1 req/sec, so concurrency=2 with 600ms spacing
    // gives ~2 req/sec sustained throughput while leaving headroom for retries.
    const CONCURRENCY = 2;
    let idx = 0;
    let done = 0;
    const total = filteredRecords.length;
    async function worker(workerId) {
      while (idx < total) {
        const myIdx = idx++;
        const rec = filteredRecords[myIdx];
        const f = rec.worst;
        const allFindingIds = rec.findings.map((x) => x.finding_id).join(",");
        const compositeReason = `[${allFindingIds}] ${f.issue} (+${rec.findings.length - 1} more finding${rec.findings.length > 1 ? "s" : ""})`;

        // Look up current metadata for Base44 entities
        let currentMeta = {};
        if (rec.entity === "PayoutItem") {
          const pi = payoutItems.find((x) => x.id === rec.entity_id);
          currentMeta = pi && pi.metadata ? pi.metadata : {};
        } else if (rec.entity === "PayoutBatch") {
          const pb = payoutBatches.find((x) => x.id === rec.entity_id);
          currentMeta = pb && pb.metadata ? pb.metadata : {};
        } else if (rec.entity === "RevenueEvent") {
          const ev = revenueEvents.find((x) => x.id === rec.entity_id);
          currentMeta = ev && ev.metadata ? ev.metadata : {};
        } else if (rec.entity === "PayoutRecipient") {
          const r = payoutRecipients.find((x) => x.id === rec.entity_id);
          currentMeta = r && r.metadata ? r.metadata : {};
        }

        const compositeFinding = { ...f, issue: compositeReason, finding_id: allFindingIds };
        let r;
        if (rec.entity === "LedgerEntry") {
          r = await quarantineLedgerEntry(rec.entity_id, compositeFinding);
        } else if (rec.entity === "PurchaseOrder") {
          r = await quarantinePO(rec.entity_id, compositeFinding);
        } else {
          r = await quarantineBase44(rec.entity, rec.entity_id, compositeFinding, currentMeta);
        }
        const action = {
          finding_ids: allFindingIds,
          entity: rec.entity,
          entity_id: rec.entity_id,
          finding_count: rec.findings.length,
          ...r,
        };
        quarantineActions.push(action);
        for (const ff of rec.findings) {
          ff.quarantine_action = action;
        }

        done++;
        if (done % 25 === 0 || done === total) {
          const pct = ((done / total) * 100).toFixed(1);
          const ok = quarantineActions.filter((a) => a.ok).length;
          const fail = quarantineActions.length - ok;
          console.log(`  [w${workerId}] ${done}/${total} (${pct}%) — ok=${ok} fail=${fail}`);
          // Write a partial report so progress is preserved if killed.
          writeFileSync(
            "/home/z/my-project/download/audit-report.partial.json",
            JSON.stringify({
              audit_run_at: new Date().toISOString(),
              mode: "apply",
              resume: RESUME,
              progress: { done, total, ok, fail },
              quarantine_actions: quarantineActions,
            }, null, 2)
          );
        }
        // Small per-request spacing to stay under the rate limit.
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i));
    await Promise.all(workers);
  }

  const succeeded = quarantineActions.filter((a) => a.ok).length;
  const failed = quarantineActions.filter((a) => a.ok === false).length;
  const dryRunCount = quarantineActions.filter((a) => a.dry_run).length;
  console.log(`\n  Quarantine actions: ${quarantineActions.length} (covering ${uniqueRecords.length} unique records)`);
  console.log(`    succeeded:    ${succeeded}`);
  console.log(`    failed:       ${failed}`);
  console.log(`    dry-run:      ${dryRunCount}`);

  // ── 5. Write report ──
  const report = {
    audit_run_id: `audit-${Date.now()}`,
    audit_run_at: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : "apply",
    audit_only: SKIP_QUARANTINE,
    base44_counts: {
      RevenueEvent: revenueEvents.length,
      PayoutBatch: payoutBatches.length,
      PayoutItem: payoutItems.length,
      PayoutRecipient: payoutRecipients.length,
    },
    ledger_state: ledgerState
      ? {
          total_entries: ledgerState.stats.total_entries,
          total_pos: ledgerState.procurement_stats.total_pos,
          settled_amount_cents: ledgerState.stats.settled_amount_cents,
          has_any_receipt: ledgerState.active_operations_balance.has_any_receipt,
        }
      : null,
    summary: {
      total_findings: deduped.length,
      by_domain: byDomain,
      by_severity: bySeverity,
      economic_exposure: {
        critical_cents: criticalExposureCents,
        warning_cents: warningExposureCents,
        by_entity: exposureByEntity,
      },
      quarantine: {
        attempted: quarantineActions.length,
        succeeded,
        failed,
        dry_run: dryRunCount,
      },
    },
    findings: deduped,
    quarantine_actions: quarantineActions,
  };

  const outJson = "/home/z/my-project/download/audit-report.json";
  writeFileSync(outJson, JSON.stringify(report, null, 2));
  console.log(`\n✓ JSON report written: ${outJson}`);

  // Markdown summary
  const md = renderMarkdown(report);
  const outMd = "/home/z/my-project/download/audit-report.md";
  writeFileSync(outMd, md);
  console.log(`✓ Markdown report written: ${outMd}`);

  console.log("\n─".repeat(72));
  console.log("AUDIT COMPLETE");
  console.log("─".repeat(72));
  console.log(`Findings:     ${deduped.length}  (critical ${bySeverity.critical}, warning ${bySeverity.warning}, info ${bySeverity.info})`);
  console.log(`Exposure:     $${(criticalExposureCents / 100).toFixed(2)} critical + $${(warningExposureCents / 100).toFixed(2)} warning`);
  if (DRY_RUN) {
    console.log(`\nThis was a DRY-RUN. To actually quarantine, re-run with --apply:`);
    console.log(`  bun /home/z/my-project/scripts/audit-and-quarantine.mjs --apply`);
  } else if (SKIP_QUARANTINE) {
    console.log(`\n--audit-only mode. No quarantine performed.`);
  } else {
    console.log(`Quarantine:   ${succeeded} succeeded, ${failed} failed`);
  }
}

function renderMarkdown(r) {
  const lines = [];
  lines.push("# ChariBaaS Forensic Audit & Losses Recovery Report");
  lines.push("");
  lines.push(`- **Audit run ID**: \`${r.audit_run_id}\``);
  lines.push(`- **Audit run at**: ${r.audit_run_at}`);
  lines.push(`- **Mode**: ${r.mode}${r.audit_only ? " (audit-only)" : ""}`);
  lines.push("");
  lines.push("## 1. Data Plane Inventory");
  lines.push("");
  lines.push("### Base44 remote API (legacy data)");
  lines.push("| Entity | Records |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(r.base44_counts)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("### In-memory settlement + procurement ledgers");
  if (r.ledger_state) {
    lines.push("| Metric | Value |");
    lines.push("|---|---|");
    lines.push(`| Total ledger entries | ${r.ledger_state.total_entries} |`);
    lines.push(`| Total POs | ${r.ledger_state.total_pos} |`);
    lines.push(`| Settled amount (cents) | ${r.ledger_state.settled_amount_cents} |`);
    lines.push(`| Has any receipt | ${r.ledger_state.has_any_receipt} |`);
  } else {
    lines.push("_(dev server not responding — ledger treated as empty)_");
  }
  lines.push("");
  lines.push("## 2. Findings Summary");
  lines.push("");
  lines.push("| Domain | Count |");
  lines.push("|---|---|");
  for (const [d, n] of Object.entries(r.summary.by_domain)) {
    lines.push(`| ${d} | ${n} |`);
  }
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|---|---|");
  lines.push(`| critical | ${r.summary.by_severity.critical} |`);
  lines.push(`| warning | ${r.summary.by_severity.warning} |`);
  lines.push(`| info | ${r.summary.by_severity.info} |`);
  lines.push("");
  lines.push("## 3. Economic Exposure");
  lines.push("");
  const ex = r.summary.economic_exposure;
  lines.push(`- **Critical exposure**: $${(ex.critical_cents / 100).toFixed(2)}`);
  lines.push(`- **Warning exposure**: $${(ex.warning_cents / 100).toFixed(2)}`);
  lines.push("");
  lines.push("| Entity | Exposure (cents) |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(ex.by_entity)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## 4. Quarantine Actions");
  lines.push("");
  const q = r.summary.quarantine;
  lines.push(`- Attempted: ${q.attempted}`);
  lines.push(`- Succeeded: ${q.succeeded}`);
  lines.push(`- Failed: ${q.failed}`);
  lines.push(`- Dry-run: ${q.dry_run}`);
  lines.push("");
  lines.push("## 5. Detailed Findings (critical first)");
  lines.push("");
  for (const f of r.findings) {
    if (f.severity === "info") continue;
    lines.push(`### ${f.finding_id} — [${f.severity.toUpperCase()}] ${f.domain}`);
    lines.push("");
    lines.push(`- **Entity**: \`${f.entity}\` / \`${f.entity_id}\``);
    lines.push(`- **External ref**: \`${f.external_ref}\``);
    lines.push(`- **Issue**: ${f.issue}`);
    lines.push(`- **Detail**: ${f.detail}`);
    if (Object.keys(f.evidence || {}).length > 0) {
      lines.push("- **Evidence**:");
      for (const [k, v] of Object.entries(f.evidence)) {
        lines.push(`  - \`${k}\`: \`${JSON.stringify(v)}\``);
      }
    }
    if (f.quarantine_action) {
      const qa = f.quarantine_action;
      lines.push(`- **Quarantine**: ${qa.ok ? "✓" : "✗"} ${qa.action || "(none)"}${qa.error ? " — " + qa.error : ""}`);
    }
    lines.push("");
  }
  lines.push("## 6. Audit Rules Applied");
  lines.push("");
  lines.push("| Domain | Rule | Severity |");
  lines.push("|---|---|---|");
  lines.push("| OwnerSettlements | external_transaction_id matches internal `txn_*` / `REV-*` / `PB-*` / `PI-*` pattern (not PayPal PAYID-*, Stripe ch_/pi_, or on-chain hash) | critical |");
  lines.push("| OwnerSettlements | recipient email uses reserved TLD (.example/.test/.invalid) or placeholder local-part (operator@/test@) | critical |");
  lines.push("| OwnerSettlements | status=success without processed_at | warning |");
  lines.push("| CryptoSettlements | recipient wallet address does not match canonical format for currency (BTC: bc1/1/3 prefix; ETH/USDT/USDC: 0x+40hex; SOL: base58 32-44) | critical |");
  lines.push("| CryptoSettlements | status=success without 64-char hex on-chain transaction hash | critical |");
  lines.push("| CryptoSettlements | wallet address shared across multiple PayoutRecipient records (misrouting sink) | warning |");
  lines.push("| CryptoSettlements | SETTLED ledger entry with non-cryptographic receipt_hash | critical |");
  lines.push("| PayoutBatches | status=approved/completed without processed_at | warning |");
  lines.push("| PayoutBatches | status=completed with zero items | critical |");
  lines.push("| PayoutBatches | total_amount ≠ sum of items (Δ > $0.01) | critical |");
  lines.push("| PayoutBatches | revenue_event_ids=[] (disconnected from revenue source) | warning |");
  lines.push("| PayoutItems | status=success with empty external_transaction_id | critical |");
  lines.push("| PayoutItems | status=success with fabricated external_transaction_id (internal format) | critical |");
  lines.push("| PayoutItems | status=refunded without error_message | warning |");
  lines.push("| RevenueEvents | event_hash is not 64-char sha256 (orchestrator.ts:858 concatenation `source_id|hit_id|reward`) | critical |");
  lines.push("| RevenueEvents | status=confirmed without confirmation_date | warning |");
  lines.push("| RevenueEvents | status=paid_out without metadata.external_confirmation_ref | critical |");
  lines.push("| RevenueEvents | source=manual_entry with non-zero amount | warning |");
  lines.push("| OwnerPayments | owner PayPal recipient uses fake email domain | critical |");
  lines.push("| OwnerPayments | owner bank_account with all-zero / sequential test routing number | critical |");
  lines.push("| OwnerPayments | owner crypto wallet address malformed for declared currency | critical |");
  lines.push("| OwnerPayments | owner bank_account with no bank_name | warning |");
  lines.push("| Procurement | PO state outside strict POState enum | critical |");
  lines.push("| Procurement | Received_Verified without three_way_match result | critical |");
  lines.push("| Procurement | Received_Verified without settlement_entry_id bridge | critical |");
  lines.push("| Procurement | In_Transit without verified CarrierScanEvent | critical |");
  lines.push("| Procurement | Shipment_Pending without tracking_number | warning |");
  lines.push("| Procurement | procurement ledger entry SETTLED without receipt_hash | critical |");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_Generated by `/home/z/my-project/scripts/audit-and-quarantine.mjs`_");
  return lines.join("\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

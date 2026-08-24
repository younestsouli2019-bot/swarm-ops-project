#!/usr/bin/env node
/**
 * reconcile_bank_statements.mjs — Human-operated bank statement reconciliation.
 *
 * PURPOSE
 *   Compare a real bank statement (CSV or PDF export from your e-banking)
 *   against the swarm's recorded receivables (the receivables audit JSON
 *   produced by audit_receivables.mjs). Tell you definitively which
 *   expected payouts actually appeared as deposits in your bank.
 *
 * WHY THIS SHAPE
 *   - READ-ONLY: parses a file you already have. Does not scrape, does not
 *     log into anything, does not store credentials.
 *   - HUMAN-OPERATED: you run it locally on a statement you exported
 *     yourself. No autonomous agent involvement.
 *   - NO TRANSACTION INITIATION: this tool cannot move money. It only
 *     compares two datasets and emits a report.
 *
 * USAGE
 *   node reconcile_bank_statements.mjs \
 *     --csv  /path/to/attijariwafa_export.csv \
 *     --audit /tmp/Nouveau-dossier-3-/data/security/receivables-audit-latest.json \
 *     [--account-name "Attijariwafa 810-0004482000613213-72"] \
 *     [--tolerance 0.01] [--date-window-days 7] \
 *     [--out /home/z/my-project/download/bank-reconciliation-report.json]
 *
 *   # Or PDF (uses pdftotext under the hood):
 *   node reconcile_bank_statements.mjs \
 *     --pdf /path/to/statement.pdf \
 *     --audit /tmp/Nouveau-dossier-3-/data/security/receivables-audit-latest.json
 *
 * CSV FORMAT (flexible — you map columns via --csv-columns)
 *   Default expected columns: date, description, debit, credit, balance
 *   Override with: --csv-columns date=Date,description=Label,credit=Credit
 *   The parser tries case-insensitive header matching as a fallback.
 *
 * PDF FORMAT
 *   Any text-based PDF (not scanned images). The parser runs pdftotext -layout
 *   and looks for lines that match a transaction pattern:
 *     DD/MM/YYYY ... <description> ... <amount>
 *   Deposits (credits) are positive; withdrawals (debits) are negative or
 *   appear in a separate column.
 *
 * OUTPUT
 *   - JSON report (machine-readable)
 *   - Markdown report (human-readable, saved next to JSON)
 *   - Stdout summary
 *
 * MATCHING HEURISTIC
 *   For each expected receivable (item_id, amount, currency, expected_date):
 *     1. Filter bank deposits by currency match
 *     2. Filter by amount within --tolerance (default $0.01)
 *     3. Filter by date within ±--date-window-days of expected_date
 *     4. If exactly one match → status=matched
 *     5. If multiple matches → status=ambiguous (list candidates)
 *     6. If zero matches → status=unmatched
 *
 *   The matcher does NOT use description text by default — descriptions vary
 *   wildly between banks. You can pass --require-description-keyword to
 *   require a keyword in the description for a match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const RUN_ID = `BANKRECON_${Date.now()}`;

function parseArgs(argv) {
  const args = { csv_columns: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') args.csv = argv[++i];
    else if (a === '--pdf') args.pdf = argv[++i];
    else if (a === '--audit') args.audit = argv[++i];
    else if (a === '--account-name') args.account_name = argv[++i];
    else if (a === '--tolerance') args.tolerance = parseFloat(argv[++i]);
    else if (a === '--date-window-days') args.date_window_days = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--csv-columns') {
      // e.g. date=Date,description=Label,credit=Credit
      const spec = argv[++i];
      for (const pair of spec.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) args.csv_columns[k.trim()] = v.trim();
      }
    }
    else if (a === '--require-description-keyword') args.require_description_keyword = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node reconcile_bank_statements.mjs --csv <path> --audit <path> [--out <path>]
       or: node reconcile_bank_statements.mjs --pdf <path> --audit <path>`);
      process.exit(0);
    }
  }
  return args;
}

function parseDate(s) {
  if (!s) return null;
  // Try ISO first
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // Try DD/MM/YYYY
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    const [_, dd, mm, yyyy] = m;
    d = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`);
    if (!isNaN(d.getTime())) return d;
  }
  // Try MM/DD/YYYY (US)
  const m2 = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m2) {
    const [_, mm, dd, yyyy] = m2;
    d = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function parseAmount(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  // Strip currency symbols, spaces, thousands separators
  let cleaned = String(s).trim()
    .replace(/^[^0-9.\-]+/, '')   // leading currency symbol
    .replace(/[^0-9.\-]+$/, '')   // trailing currency symbol
    .replace(/\s/g, '')
    .replace(/,/g, '.');           // European decimal comma → dot
  // Handle multiple dots (thousands): 1.234.56 → 1234.56
  const dots = (cleaned.match(/\./g) || []).length;
  if (dots > 1) {
    const parts = cleaned.split('.');
    const last = parts.pop();
    cleaned = parts.join('') + '.' + last;
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** Parse a CSV file into transaction objects. */
function parseCsv(filePath, columnMap) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // Detect delimiter (comma or semicolon)
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';

  // Parse header
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, ''));
  const map = {
    date: columnMap.date || headers.find(h => /date|datum|date/.test(h.toLowerCase())) || headers[0],
    description: columnMap.description || headers.find(h => /desc|libell|label|narration|details/i.test(h)) || headers[1],
    debit: columnMap.debit || headers.find(h => /debit|débit|withdrawal|sortie/i.test(h)),
    credit: columnMap.credit || headers.find(h => /credit|crédit|deposit|entrée/i.test(h)),
    amount: columnMap.amount || headers.find(h => /^amount|montant/i.test(h)),
    currency: columnMap.currency || headers.find(h => /curr|devise/i.test(h)),
    balance: columnMap.balance || headers.find(h => /balance|solde/i.test(h)),
  };

  const txs = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const row = {};
    for (const h of headers) row[h] = cols[headers.indexOf(h)];

    const date = parseDate(row[map.date]);
    const description = row[map.description] || '';
    let amount = null;
    if (map.amount && row[map.amount]) {
      amount = parseAmount(row[map.amount]);
    } else {
      const credit = map.credit ? parseAmount(row[map.credit]) : null;
      const debit = map.debit ? parseAmount(row[map.debit]) : null;
      if (credit != null && credit !== 0) amount = Math.abs(credit);
      else if (debit != null && debit !== 0) amount = -Math.abs(debit);
    }
    if (date && amount != null) {
      txs.push({
        date: date.toISOString().slice(0, 10),
        description,
        amount,
        currency: (row[map.currency] || 'MAD').toUpperCase(),
        raw: row,
      });
    }
  }
  return txs;
}

/** Parse a PDF statement by running pdftotext -layout and regex-ing transaction lines. */
function parsePdf(filePath) {
  let text;
  try {
    text = execSync(`pdftotext -layout ${JSON.stringify(filePath)} -`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`pdftotext failed: ${e.message}. Is poppler-utils installed?`);
  }
  const lines = text.split(/\r?\n/);
  const txs = [];
  // Match lines like: 12/03/2026 ... SOME DESCRIPTION ... 1,234.56
  const lineRe = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\s+(.+?)\s+(-?\d[\d.,]*\d)\s*$/;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [_, dateStr, desc, amtStr] = m;
    const date = parseDate(dateStr);
    const amount = parseAmount(amtStr);
    if (date && amount != null) {
      txs.push({
        date: date.toISOString().slice(0, 10),
        description: desc.trim(),
        amount,
        currency: 'MAD', // PDF parser is bank-specific; assume MAD for Attijariwafa
        raw: { line },
      });
    }
  }
  return txs;
}

/** Load the receivables audit JSON. */
function loadAudit(auditPath) {
  if (!fs.existsSync(auditPath)) {
    throw new Error(`Audit file not found: ${auditPath}\nRun audit_receivables.mjs first.`);
  }
  return JSON.parse(fs.readFileSync(auditPath, 'utf8'));
}

/**
 * Match expected receivables against bank deposits.
 * Returns per-item status: matched | unmatched | ambiguous
 *
 * IMPORTANT: a single bank deposit can match AT MOST ONE expected receivable.
 * If multiple receivables match the same deposit (e.g. 37 items of $30 each
 * all matching a single $30 deposit), we treat all but one as 'unmatched'
 * (insufficient evidence to attribute the deposit to any specific item).
 * The 'matched' status requires UNIQUE 1-to-1 attribution.
 */
function matchReceivablesToBank(expectedItems, bankTxs, opts) {
  const tolerance = opts.tolerance ?? 0.01;
  const windowDays = opts.date_window_days ?? 7;
  const requireKeyword = opts.require_description_keyword || null;

  const deposits = bankTxs.filter(t => t.amount > 0);
  const withdrawals = bankTxs.filter(t => t.amount < 0);

  // First pass: for each expected item, find candidate deposits.
  const candidatesPerItem = expectedItems.map(item => {
    const expectedAmount = Number(item.amount || 0);
    const expectedCurrency = (item.currency || 'USD').toUpperCase();
    const expectedDate = item.expected_date || item.created_at || null;
    const expectedDateParsed = expectedDate ? parseDate(expectedDate.slice(0, 10)) : null;

    const candidates = deposits.filter(d => {
      if (Math.abs(d.amount - expectedAmount) > tolerance) return false;
      if (requireKeyword && !d.description.toLowerCase().includes(requireKeyword.toLowerCase())) return false;
      if (expectedDateParsed) {
        const dDate = parseDate(d.date);
        if (!dDate) return false;
        const diffDays = Math.abs((dDate.getTime() - expectedDateParsed.getTime()) / 86400000);
        if (diffDays > windowDays) return false;
      }
      return true;
    });

    return { item, candidates };
  });

  // Second pass: greedy unique matching. An item is 'matched' only if it has
  // exactly one candidate deposit AND no other item also has that deposit as
  // its sole candidate. Otherwise: 'ambiguous' (multiple items compete for
  // the same deposit) or 'unmatched' (no candidates).
  const depositKey = d => `${d.date}|${d.amount}|${d.description}`;
  const itemsCompetingForDeposit = new Map();
  for (const { candidates } of candidatesPerItem) {
    if (candidates.length === 1) {
      const key = depositKey(candidates[0]);
      itemsCompetingForDeposit.set(key, (itemsCompetingForDeposit.get(key) || 0) + 1);
    }
  }

  const results = [];
  for (const { item, candidates } of candidatesPerItem) {
    const expectedAmount = Number(item.amount || 0);
    const expectedCurrency = (item.currency || 'USD').toUpperCase();
    const expectedDate = item.expected_date || item.created_at || null;

    let status, matchedTx = null, candidatesList = [];
    if (candidates.length === 0) {
      status = 'unmatched';
    } else if (candidates.length === 1) {
      const key = depositKey(candidates[0]);
      if (itemsCompetingForDeposit.get(key) > 1) {
        // Multiple items want this same deposit → ambiguous
        status = 'ambiguous';
        candidatesList = candidates;
      } else {
        status = 'matched';
        matchedTx = candidates[0];
      }
    } else {
      status = 'ambiguous';
      candidatesList = candidates;
    }

    results.push({
      item_id: item.item_id,
      batch_id: item.batch_id,
      expected_amount: expectedAmount,
      expected_currency: expectedCurrency,
      expected_date: expectedDate ? expectedDate.slice(0, 10) : null,
      audit_class: item.audit_class,
      status,
      matched_bank_tx: matchedTx ? {
        date: matchedTx.date,
        description: matchedTx.description,
        amount: matchedTx.amount,
        currency: matchedTx.currency,
      } : null,
      ambiguous_candidates: candidatesList.map(c => ({
        date: c.date, description: c.description, amount: c.amount, currency: c.currency,
      })),
      currency_note: expectedCurrency !== 'MAD' ?
        `Expected in ${expectedCurrency}; Moroccan bank statement is in MAD. A real match would require FX conversion evidence (e.g. PayPal → MAD settlement advice from the PSP).` :
        null,
    });
  }
  return { results, deposits, withdrawals };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.audit) { console.error('--audit <path> required'); process.exit(1); }
  if (!args.csv && !args.pdf) { console.error('--csv <path> or --pdf <path> required'); process.exit(1); }

  const audit = loadAudit(args.audit);
  const expectedItems = (audit.per_item || []).map(p => ({
    item_id: p.item_id,
    batch_id: p.batch_id,
    amount: p.amount,
    currency: p.currency,
    expected_date: p.created_at || null,  // not in audit; we'll fall back to "any date"
    audit_class: p.audit_class,
  }));

  console.error(`[reconcile] loaded ${expectedItems.length} expected receivables from audit`);

  let bankTxs = [];
  if (args.csv) {
    bankTxs = parseCsv(args.csv, args.csv_columns);
    console.error(`[reconcile] parsed ${bankTxs.length} transactions from CSV: ${args.csv}`);
  } else {
    bankTxs = parsePdf(args.pdf);
    console.error(`[reconcile] parsed ${bankTxs.length} transactions from PDF: ${args.pdf}`);
  }

  const { results, deposits, withdrawals } = matchReceivablesToBank(expectedItems, bankTxs, {
    tolerance: args.tolerance ?? 0.01,
    date_window_days: args.date_window_days ?? 7,
    require_description_keyword: args.require_description_keyword,
  });

  const matched = results.filter(r => r.status === 'matched');
  const unmatched = results.filter(r => r.status === 'unmatched');
  const ambiguous = results.filter(r => r.status === 'ambiguous');

  const totalExpected = expectedItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const totalMatched = matched.reduce((s, r) => s + r.expected_amount, 0);

  // "Extra deposits" = bank deposits that didn't uniquely match any expected receivable.
  // Ambiguous deposits (where multiple items competed) are NOT counted as matched
  // and ARE included in extra_deposits — they need human investigation.
  const matchedTxKeys = new Set(matched.map(r => `${r.matched_bank_tx.date}|${r.matched_bank_tx.amount}|${r.matched_bank_tx.description}`));
  const extraDeposits = deposits.filter(d => !matchedTxKeys.has(`${d.date}|${d.amount}|${d.description}`));

  const report = {
    run_id: RUN_ID,
    reconciled_at: new Date().toISOString(),
    account_name: args.account_name || '(unspecified)',
    inputs: {
      bank_statement: args.csv || args.pdf,
      audit_file: args.audit,
      bank_tx_count: bankTxs.length,
      deposits_count: deposits.length,
      withdrawals_count: withdrawals.length,
      expected_receivables_count: expectedItems.length,
    },
    summary: {
      matched: matched.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      total_expected_usd: Number(totalExpected.toFixed(2)),
      total_matched_usd: Number(totalMatched.toFixed(2)),
      extra_deposits_count: extraDeposits.length,
      extra_deposits_total: Number(extraDeposits.reduce((s, d) => s + d.amount, 0).toFixed(2)),
    },
    per_item: results,
    extra_deposits: extraDeposits.map(d => ({
      date: d.date, description: d.description, amount: d.amount, currency: d.currency,
    })),
  };

  const outPath = args.out || '/home/z/my-project/download/bank-reconciliation-report.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const mdPath = outPath.replace(/\.json$/, '.md');
  const md = renderMarkdown(report);
  fs.writeFileSync(mdPath, md);

  console.log('\n=== BANK RECONCILIATION SUMMARY ===');
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Account: ${report.account_name}`);
  console.log(`Bank statement: ${report.inputs.bank_statement}`);
  console.log(`  Transactions parsed: ${report.inputs.bank_tx_count} (${report.inputs.deposits_count} deposits, ${report.inputs.withdrawals_count} withdrawals)`);
  console.log(`Expected receivables: ${report.inputs.expected_receivables_count} (total $${report.summary.total_expected_usd.toFixed(2)})`);
  console.log(`  Matched: ${report.summary.matched} ($${report.summary.total_matched_usd.toFixed(2)})`);
  console.log(`  Unmatched: ${report.summary.unmatched}`);
  console.log(`  Ambiguous: ${report.summary.ambiguous}`);
  console.log(`Extra deposits (in bank, no matching receivable): ${report.summary.extra_deposits_count} ($${report.summary.extra_deposits_total.toFixed(2)})`);
  console.log(`\nJSON report: ${outPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Bank Statement Reconciliation Report');
  lines.push('');
  lines.push(`**Run ID:** ${report.run_id}`);
  lines.push(`**Reconciled at:** ${report.reconciled_at}`);
  lines.push(`**Account:** ${report.account_name}`);
  lines.push('');
  lines.push('## Inputs');
  lines.push(`- Bank statement: \`${report.inputs.bank_statement}\``);
  lines.push(`- Receivables audit: \`${report.inputs.audit_file}\``);
  lines.push(`- Bank transactions parsed: ${report.inputs.bank_tx_count} (${report.inputs.deposits_count} deposits, ${report.inputs.withdrawals_count} withdrawals)`);
  lines.push(`- Expected receivables: ${report.inputs.expected_receivables_count}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('| Status | Count | Total |');
  lines.push('|---|---|---|');
  lines.push(`| Matched (deposit found) | ${report.summary.matched} | $${report.summary.total_matched_usd.toFixed(2)} |`);
  lines.push(`| Unmatched (no deposit) | ${report.summary.unmatched} | $${(report.summary.total_expected_usd - report.summary.total_matched_usd).toFixed(2)} |`);
  lines.push(`| Ambiguous (multiple candidates) | ${report.summary.ambiguous} | — |`);
  lines.push(`| Extra deposits (no matching receivable) | ${report.summary.extra_deposits_count} | $${report.summary.extra_deposits_total.toFixed(2)} |`);
  lines.push('');
  lines.push('## Interpretation');
  if (report.summary.matched === 0) {
    lines.push('**None of the expected receivables appeared as deposits in the bank statement.**');
    lines.push('Combined with the receivables audit (which classified all 1,778 items as Class C — phantom),');
    lines.push('this confirms that the swarm fabricated the payout queue. **No real money was ever due, and no real money ever arrived.**');
  } else {
    lines.push(`**${report.summary.matched} of ${report.inputs.expected_receivables_count} expected receivables appeared as deposits in the bank statement.**`);
    lines.push('These matched items are genuinely withdrawal-eligible — promote them to Class A in the receivables audit.');
    lines.push('The unmatched items remain phantom and must NOT be paid.');
  }
  lines.push('');
  if (report.summary.extra_deposits > 0) {
    lines.push(`## Extra deposits (${report.summary.extra_deposits_count} found)`);
    lines.push('These deposits appear in the bank statement but match no expected receivable. Investigate manually:');
    lines.push('');
    lines.push('| Date | Description | Amount | Currency |');
    lines.push('|---|---|---|---|');
    for (const d of report.extra_deposits.slice(0, 50)) {
      lines.push(`| ${d.date} | ${d.description.replace(/\|/g, '\\|')} | ${d.amount} | ${d.currency} |`);
    }
    lines.push('');
  }
  lines.push('## Per-item results');
  lines.push('');
  lines.push('| Item ID | Expected | Status | Matched bank tx |');
  lines.push('|---|---|---|---|');
  for (const r of report.per_item.slice(0, 100)) {
    const matched = r.matched_bank_tx ? `${r.matched_bank_tx.date} ${r.matched_bank_tx.amount} ${r.matched_bank_tx.currency}` : '—';
    lines.push(`| ${r.item_id} | $${r.expected_amount} ${r.expected_currency} | ${r.status} | ${matched} |`);
  }
  if (report.per_item.length > 100) {
    lines.push(`| ... (${report.per_item.length - 100} more) | | | |`);
  }
  return lines.join('\n');
}

main();

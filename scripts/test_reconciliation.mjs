// Verification that generateCorrelationId matches the operator's Python spec.
//
// Python reference:
//   def generate_correlation_id(amount, val_date, bank_ref, account_id):
//       normalized_str = f"{float(amount):.2f}|{val_date.strip()}|{bank_ref.strip()}|{account_id.strip()}"
//       return hashlib.sha256(normalized_str.encode('utf-8')).hexdigest()
//
// We compute the expected sha256 by hand for a few test cases using
// node's crypto module and compare against the TS implementation.

import { createHash } from "node:crypto";
import { generateCorrelationId, matchStatementsToPayouts, parseCsvStatement, runReconciliation } from "../src/lib/reconciliation.ts";

function expectedHash(amount, val_date, bank_ref, account_id) {
  const normalized = `${Number(amount).toFixed(2)}|${val_date.trim()}|${bank_ref.trim()}|${account_id.trim()}`;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

const testCases = [
  { amount: 100, val_date: "2026-08-16", bank_ref: "TRN123", account_id: "ACC001" },
  { amount: 49.99, val_date: "2026-08-15", bank_ref: "PAYID-ABC123", account_id: "iban-1" },
  { amount: 0.5, val_date: "  2026-08-14  ", bank_ref: "  ref-with-spaces  ", account_id: " acc-spaced " }, // tests stripping
  { amount: 1234.5, val_date: "", bank_ref: "", account_id: "test-empty" },
];

let pass = 0;
let fail = 0;
for (const tc of testCases) {
  const expected = expectedHash(tc.amount, tc.val_date, tc.bank_ref, tc.account_id);
  const actual = generateCorrelationId(tc.amount, tc.val_date, tc.bank_ref, tc.account_id);
  if (expected === actual) {
    pass++;
    console.log(`PASS  ${JSON.stringify(tc)} -> ${actual.slice(0, 16)}...`);
  } else {
    fail++;
    console.log(`FAIL  ${JSON.stringify(tc)}`);
    console.log(`      expected: ${expected}`);
    console.log(`      actual:   ${actual}`);
  }
}

// Test full reconciliation matching with a synthetic case
const stmt = [
  { bank_ref: "TRN001", val_date: "2026-08-16", amount: 100.00, currency: "USD", account_id: "ACC001", raw: "line1" },
  { bank_ref: "TRN002", val_date: "2026-08-15", amount: 49.99, currency: "USD", account_id: "ACC001", raw: "line2" },
  { bank_ref: "TRN003", val_date: "2026-08-14", amount: 500.00, currency: "USD", account_id: "ACC002", raw: "line3" },
];
const payouts = [
  { payout_id: "p1", amount: 100.00, currency: "USD", bank_ref: "TRN001", val_date: "2026-08-16", account_id: "ACC001", state: "settled" },
  { payout_id: "p2", amount: 49.99, currency: "USD", bank_ref: null, val_date: null, account_id: "ACC001", state: "submitted" },  // amount-only match expected (no val_date)
  { payout_id: "p3", amount: 999.00, currency: "USD", bank_ref: null, val_date: null, account_id: "ACC999", state: "submitted" }, // no match expected
  { payout_id: "p4", amount: 500.00, currency: "USD", bank_ref: null, val_date: "2026-08-13", account_id: "ACC002", state: "submitted" }, // partial medium-confidence (val_date within 3-day window of stmt val_date 2026-08-14)
];
const matches = matchStatementsToPayouts(stmt, payouts);
console.log(`\nMatching test: ${matches.length} matches (expected 3)`);
const p1 = matches.find(m => m.payout_id === "p1");
const p2 = matches.find(m => m.payout_id === "p2");
const p4 = matches.find(m => m.payout_id === "p4");
if (p1 && p1.confidence === "high" && p1.match_method === "full_hash") { pass++; console.log("PASS  p1 high-confidence full-hash match"); }
else { fail++; console.log(`FAIL  p1 expected high/full_hash, got ${p1?.confidence}/${p1?.match_method}`); }
if (p2 && p2.confidence === "low" && p2.match_method === "amount_only") {
  pass++; console.log(`PASS  p2 low-confidence amount-only match (correct — payout val_date was null, can't claim medium)`);
} else {
  fail++; console.log(`FAIL  p2 expected low/amount_only (no val_date for date window), got ${p2?.confidence}/${p2?.match_method}`);
}
if (p4 && p4.confidence === "medium" && p4.match_method === "partial_amount_account_date") {
  pass++; console.log("PASS  p4 medium-confidence partial match (val_date within window, no bank_ref)");
} else {
  fail++; console.log(`FAIL  p4 expected medium/partial_amount_account_date, got ${p4?.confidence}/${p4?.match_method}`);
}

// Test CSV parsing with synthetic data
const csvText = `Date,Description,Debit,Credit,Balance,TRN
2026-08-16,Deposit from system,,100.00,1100.00,TRN001
2026-08-15,Wire transfer,,49.99,1000.00,TRN002
2026-08-14,Rent payment,500.00,,500.00,TRN003
`;
const csvLines = parseCsvStatement(csvText, { account_id: "ACC001", currency: "USD" });
console.log(`\nCSV parse: ${csvLines.length} credit lines (expected 2)`);
if (csvLines.length === 2) { pass++; console.log("PASS  CSV parser extracted 2 credits (ignored debit)"); }
else { fail++; console.log(`FAIL  CSV parser expected 2 credit lines, got ${csvLines.length}`); }
if (csvLines[0]?.bank_ref === "TRN001") { pass++; console.log("PASS  CSV parser found TRN column"); }
else { fail++; console.log(`FAIL  CSV parser bank_ref expected TRN001, got ${csvLines[0]?.bank_ref}`); }

// Full report test
const report = runReconciliation({
  statement_source: "test-csv",
  statement_lines: stmt,
  internal_payouts: payouts,
});
if (report.summary.matched_count === 3 && report.summary.unmatched_payout_count === 1 && report.summary.unmatched_statement_count === 0) {
  pass++; console.log("PASS  report summary: 3 matched, 1 unmatched payout, 0 unmatched statement");
} else {
  fail++; console.log(`FAIL  report summary: matched=${report.summary.matched_count}, unmatched_payouts=${report.summary.unmatched_payout_count}, unmatched_statements=${report.summary.unmatched_statement_count}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

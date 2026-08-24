#!/usr/bin/env node
/**
 * reconcile_correlation.mjs — Bank statement reconciliation CLI.
 *
 * PURPOSE
 *   Match a real bank statement (CSV / MT940 / BAI2 you exported
 *   yourself from e-banking) against the swarm's submitted payouts
 *   using SHA-256 correlation IDs. Produce a report telling you:
 *     - which payouts were matched to which statement lines
 *     - the confidence of each match (high / medium / low)
 *     - which statement lines have no matching payout
 *     - which payouts have no matching statement line
 *
 * WHY THIS SHAPE
 *   - READ-ONLY: parses a file you already have. Does not scrape, does
 *     not log into anything, does not store credentials, does not move
 *     money.
 *   - HUMAN-OPERATED: you run it locally on a statement you exported
 *     yourself. No autonomous agent involvement.
 *   - NO TRANSACTION INITIATION: this tool cannot move money.
 *
 * USAGE
 *   # CSV (default columns: date, description, debit, credit, balance)
 *   node reconcile_correlation.mjs \
 *     --csv /path/to/attijariwafa_export.csv \
 *     --account-id "MA640115780000448200061321372" \
 *     --currency MAD
 *
 *   # CSV with custom column mapping
 *   node reconcile_correlation.mjs \
 *     --csv statement.csv \
 *     --csv-columns date="Value Date",credit=Credit,bank_ref=TRN,description=Label \
 *     --account-id "GB29NWBK60161331926819" --currency GBP
 *
 *   # MT940 (European / Moroccan banks)
 *   node reconcile_correlation.mjs --mt940 /path/to/statement.sta --currency EUR
 *
 *   # BAI2 (US banks)
 *   node reconcile_correlation.mjs --bai2 /path/to/statement.bai2
 *
 *   # Output
 *   --out /home/z/my-project/download/reconciliation-report.json   (default)
 *   --out-md /home/z/my-project/download/reconciliation-report.md
 *
 * OUTPUT
 *   - JSON report (machine-readable)
 *   - Markdown report (human-readable)
 *   - Stdout summary
 *
 * MATCHING
 *   The engine uses the operator-specified SHA-256 correlation formula:
 *
 *     normalized_str = f"{float(amount):.2f}|{val_date.strip()}|{bank_ref.strip()}|{account_id.strip()}"
 *     correlation_id = sha256(normalized_str.encode('utf-8')).hexdigest()
 *
 *   Same formula is computed on both sides (internal payout + bank
 *   statement line). Matching priority:
 *     1. Full hash match (high confidence)
 *     2. Partial match: amount + currency + account_id + date window (medium)
 *     3. Amount + currency + account_id only (low — needs human review)
 */

import fs from "node:fs";
import path from "node:path";

const RUN_ID = `RECON_${Date.now()}`;

function parseArgs(argv) {
  const args = { csv_columns: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--csv") args.csv = argv[++i];
    else if (a === "--mt940") args.mt940 = argv[++i];
    else if (a === "--bai2") args.bai2 = argv[++i];
    else if (a === "--account-id") args.account_id = argv[++i];
    else if (a === "--currency") args.currency = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--out-md") args.out_md = argv[++i];
    else if (a === "--csv-columns") {
      const spec = argv[++i];
      for (const pair of spec.split(",")) {
        const [k, v] = pair.split("=");
        if (k && v) args.csv_columns[k.trim()] = v.trim();
      }
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: node reconcile_correlation.mjs --csv <path> [--mt940 <path> | --bai2 <path>]
       [--account-id <iban>] [--currency <ccy>]
       [--csv-columns date="Value Date",credit=Credit,bank_ref=TRN]
       [--out <json-path>] [--out-md <md-path>]`);
      process.exit(0);
    }
  }
  return args;
}

async function loadReconciliationModule() {
  // Load the TS module via the experimental strip-types flag.
  const mod = await import(
    "file://" + path.resolve("./src/lib/reconciliation.ts").replace(/\\/g, "/")
  );
  return mod;
}

async function loadInternalPayouts() {
  // Query the live payout state machine + the Base44 PayoutItem table
  // for any submitted/settled payouts that need reconciliation.
  // For now we just use the in-memory state machine.
  const stateMachine = await import(
    "file://" + path.resolve("./src/lib/payout-state-machine.ts").replace(/\\/g, "/")
  );
  const payouts = stateMachine.listPayouts({ limit: 500 });
  return payouts
    .filter((p) => p.state === "submitted" || p.state === "settled")
    .map((p) => ({
      payout_id: p.id,
      amount: p.amount_cents / 100,
      currency: p.currency,
      bank_ref: p.external_reference,
      val_date: null,
      account_id: p.recipient_id,
      state: p.state,
    }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv && !args.mt940 && !args.bai2) {
    console.error("ERROR: must specify --csv, --mt940, or --bai2");
    process.exit(1);
  }
  const reconModule = await loadReconciliationModule();
  const internalPayouts = await loadInternalPayouts();

  let statementSource = "(none)";
  let statementLines = [];

  if (args.csv) {
    const text = fs.readFileSync(args.csv, "utf8");
    statementSource = `csv:${args.csv}`;
    statementLines = reconModule.parseCsvStatement(text, {
      csv_columns: args.csv_columns,
      account_id: args.account_id,
      currency: args.currency,
    });
  } else if (args.mt940) {
    const text = fs.readFileSync(args.mt940, "utf8");
    statementSource = `mt940:${args.mt940}`;
    statementLines = reconModule.parseMt940Statement(text, {
      default_account_id: args.account_id,
      default_currency: args.currency,
    });
  } else if (args.bai2) {
    const text = fs.readFileSync(args.bai2, "utf8");
    statementSource = `bai2:${args.bai2}`;
    statementLines = reconModule.parseBai2Statement(text, {
      default_currency: args.currency,
    });
  }

  console.log(`[${RUN_ID}] statement: ${statementSource}`);
  console.log(`[${RUN_ID}]   ${statementLines.length} credit lines parsed`);
  console.log(`[${RUN_ID}] internal payouts: ${internalPayouts.length} (submitted/settled)`);

  const report = reconModule.runReconciliation({
    statement_source: statementSource,
    statement_lines: statementLines,
    internal_payouts: internalPayouts,
  });

  const outPath = args.out || "/home/z/my-project/download/reconciliation-report.json";
  const outMdPath = args.out_md || "/home/z/my-project/download/reconciliation-report.md";
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Markdown
  const md = [
    `# Bank Statement Reconciliation Report`,
    ``,
    `- **Run ID**: ${RUN_ID}`,
    `- **Started**: ${report.started_at}`,
    `- **Finished**: ${report.finished_at}`,
    `- **Statement source**: ${report.statement_source}`,
    `- **Statement credit lines**: ${report.statement_line_count}`,
    `- **Internal payouts (submitted/settled)**: ${report.internal_payout_count}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Matched | ${report.summary.matched_count} |`,
    `| Matched total | $${(report.summary.matched_total_cents / 100).toFixed(2)} |`,
    `| Unmatched statement lines | ${report.summary.unmatched_statement_count} |`,
    `| Unmatched internal payouts | ${report.summary.unmatched_payout_count} |`,
    `| High confidence matches | ${report.summary.by_confidence.high} |`,
    `| Medium confidence matches | ${report.summary.by_confidence.medium} |`,
    `| Low confidence matches | ${report.summary.by_confidence.low} |`,
    ``,
    `## Matched Payouts`,
    ``,
    `| payout_id | amount | currency | confidence | method | bank_ref | correlation_id |`,
    `|---|---:|---|---|---|---|---|`,
    ...report.matched.map(
      (m) =>
        `| ${m.payout_id} | ${m.statement.amount.toFixed(2)} | ${m.statement.currency} | ${m.confidence} | ${m.match_method} | \`${m.bank_statement_ref}\` | \`${m.correlation_id.slice(0, 16)}...\` |`
    ),
    ``,
    `## Next Steps`,
    ``,
    `1. For each high-confidence match: POST to /api/payouts/reconcile with payout_id + bank_statement_ref to transition settled → reconciled.`,
    `2. For each medium-confidence match: human review — confirm the bank_ref and val_date match expected before reconciling.`,
    `3. For each low-confidence match: human review required — only the amount and account matched.`,
    `4. Unmatched statement lines: deposits that have no corresponding internal payout. Investigate if unexpected.`,
    `5. Unmatched internal payouts: payouts that have not yet appeared on a bank statement. May still be in transit.`,
    ``,
  ].join("\n");
  fs.writeFileSync(outMdPath, md);

  console.log(`\n[${RUN_ID}] DONE`);
  console.log(`  matched: ${report.summary.matched_count} (high=${report.summary.by_confidence.high} med=${report.summary.by_confidence.medium} low=${report.summary.by_confidence.low})`);
  console.log(`  matched total: $${(report.summary.matched_total_cents / 100).toFixed(2)}`);
  console.log(`  unmatched statements: ${report.summary.unmatched_statement_count}`);
  console.log(`  unmatched payouts: ${report.summary.unmatched_payout_count}`);
  console.log(`  JSON: ${outPath}`);
  console.log(`  MD:   ${outMdPath}`);
}

main().catch((err) => {
  console.error(`[${RUN_ID}] FATAL:`, err);
  process.exit(1);
});

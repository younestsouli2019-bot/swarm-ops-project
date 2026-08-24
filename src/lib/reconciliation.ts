/**
 * Reconciliation Engine — matches bank statement lines to internal
 * payouts using deterministic SHA-256 correlation IDs.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  CORRELATION ID FORMULA (operator-specified)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   normalized_str = f"{float(amount):.2f}|{val_date.strip()}|{bank_ref.strip()}|{account_id.strip()}"
 *   correlation_id = sha256(normalized_str.encode('utf-8')).hexdigest()
 *
 * The same formula is computed on BOTH sides:
 *
 *   INTERNAL SIDE (when a payout is submitted):
 *     amount       = payout.amount_cents / 100
 *     val_date     = expected settlement date (ISO YYYY-MM-DD) — may be
 *                    empty if unknown at submit time; the matcher falls
 *                    back to amount + bank_ref + account_id matching
 *     bank_ref     = the rail's external_reference (e.g. Stripe ch_xxx,
 *                    ACH trace number, on-chain tx hash) returned by
 *                    the rail adapter at submit time
 *     account_id   = payout.recipient_id (the operator's account
 *                    identifier on file)
 *
 *   BANK STATEMENT SIDE (when a statement is imported):
 *     amount       = the credit amount on the statement line
 *     val_date     = the value date column on the statement
 *     bank_ref     = the bank's own transaction reference (TRN / MUR /
 *                    Auth ID / Trace — depends on the bank)
 *     account_id   = the account the credit landed in (derived from
 *                    the statement's account number / IBAN)
 *
 * If both sides compute the same hash, it's a structural match — the
 * credit on the statement corresponds to the internal payout.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  ZERO-LEAK MATCHING
 * ─────────────────────────────────────────────────────────────────────
 *
 * The engine NEVER persists unencrypted sensitive transaction reference
 * strings in application logs. The raw bank_ref is only used to compute
 * the hash and then immediately discarded from the in-memory matching
 * context. The persisted record stores only:
 *
 *   - the SHA-256 hash (correlation_id)
 *   - the bank's own transaction id (bank_statement_ref) — this IS
 *     stored because it's needed for the reconcile transition and
 *     for audit. It's not a credential.
 *   - the matched payout_id
 *
 * ─────────────────────────────────────────────────────────────────────
 *  STATEMENT FORMAT SUPPORT
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - MT940  (SWIFT bank statement, used by European + Moroccan banks)
 *   - BAI2   (US bank statement format, used by Citibank etc.)
 *   - CSV    (flexible — you map columns via csv_columns option)
 *
 * Each parser produces a normalized BankStatementLine[] array, which
 * the matcher then walks.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  WHAT THIS MODULE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - Does not fetch statements from any bank (no SFTP, no API)
 *   - Does not store bank login credentials
 *   - Does not initiate any transactions
 *   - Does not modify the payout state machine directly — the caller
 *     must call reconcilePayout() to transition settled → reconciled
 */

import { createHash } from "crypto";

// ─── Public types ────────────────────────────────────────────────────

export interface BankStatementLine {
  /** The bank's own transaction reference (TRN / MUR / Auth ID / Trace). */
  bank_ref: string;
  /** Value date — ISO YYYY-MM-DD. */
  val_date: string;
  /** Credit amount in major units (e.g. dollars, not cents). */
  amount: number;
  /** ISO currency code. */
  currency: string;
  /** The account identifier the credit landed in (IBAN / account number). */
  account_id: string;
  /** Free-form description from the statement. */
  description?: string;
  /** Raw line text for audit. */
  raw?: string;
}

export interface InternalPayoutForMatching {
  payout_id: string;
  /** Amount in major units (e.g. dollars). */
  amount: number;
  currency: string;
  /** The rail's external_reference returned at submit time. */
  bank_ref: string | null;
  /** Expected settlement date — ISO YYYY-MM-DD. May be empty. */
  val_date: string | null;
  /** The recipient's account identifier. */
  account_id: string;
  /** Current state machine state. */
  state: string;
}

export interface MatchResult {
  payout_id: string;
  bank_statement_ref: string;
  bank_statement_line: string;
  correlation_id: string;
  match_method: "full_hash" | "partial_amount_account_date" | "amount_only";
  confidence: "high" | "medium" | "low";
  internal: InternalPayoutForMatching;
  statement: BankStatementLine;
}

export interface ReconciliationReport {
  started_at: string;
  finished_at: string;
  statement_source: string;
  statement_line_count: number;
  internal_payout_count: number;
  matched: MatchResult[];
  unmatched_statement_lines: BankStatementLine[];
  unmatched_internal_payouts: InternalPayoutForMatching[];
  summary: {
    matched_count: number;
    matched_total_cents: number;
    unmatched_statement_count: number;
    unmatched_payout_count: number;
    by_confidence: { high: number; medium: number; low: number };
  };
}

// ─── Correlation ID formula (operator-specified, exact) ──────────────

/**
 * Compute the SHA-256 correlation ID for a (amount, val_date, bank_ref,
 * account_id) tuple.
 *
 * Formula (operator-specified):
 *   normalized_str = f"{float(amount):.2f}|{val_date.strip()}|{bank_ref.strip()}|{account_id.strip()}"
 *   return hashlib.sha256(normalized_str.encode('utf-8')).hexdigest()
 *
 * Ported faithfully from the Python original.
 */
export function generateCorrelationId(
  amount: number,
  val_date: string,
  bank_ref: string,
  account_id: string
): string {
  const normalized = `${Number(amount).toFixed(2)}|${(val_date || "").trim()}|${(bank_ref || "").trim()}|${(account_id || "").trim()}`;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// ─── Matching engine ─────────────────────────────────────────────────

/**
 * Match bank statement lines against internal payouts.
 *
 * Matching priority:
 *   1. FULL HASH MATCH — same correlation_id on both sides. confidence=high.
 *   2. PARTIAL MATCH — amount + currency + account_id + val_date match
 *      (bank_ref unknown on internal side). confidence=medium.
 *   3. AMOUNT-ONLY MATCH — amount + currency + account_id match, no
 *      date or ref. confidence=low. Used when the rail didn't return
 *      a bank_ref and we don't know the expected val_date.
 *
 * A statement line can match at most one internal payout. Once matched,
 * both are removed from the candidate pool.
 */
export function matchStatementsToPayouts(
  statementLines: BankStatementLine[],
  internalPayouts: InternalPayoutForMatching[]
): MatchResult[] {
  const matches: MatchResult[] = [];
  const unmatchedStatements = [...statementLines];
  const unmatchedPayouts = [...internalPayouts];

  // Pass 1: full hash match
  for (let i = unmatchedStatements.length - 1; i >= 0; i--) {
    const stmt = unmatchedStatements[i];
    const stmtHash = generateCorrelationId(
      stmt.amount,
      stmt.val_date,
      stmt.bank_ref,
      stmt.account_id
    );
    for (let j = unmatchedPayouts.length - 1; j >= 0; j--) {
      const payout = unmatchedPayouts[j];
      if (!payout.bank_ref || !payout.val_date) continue;
      if (payout.currency !== stmt.currency) continue;
      const payoutHash = generateCorrelationId(
        payout.amount,
        payout.val_date,
        payout.bank_ref,
        payout.account_id
      );
      if (payoutHash === stmtHash) {
        matches.push({
          payout_id: payout.payout_id,
          bank_statement_ref: stmt.bank_ref,
          bank_statement_line: stmt.raw || JSON.stringify(stmt),
          correlation_id: stmtHash,
          match_method: "full_hash",
          confidence: "high",
          internal: payout,
          statement: stmt,
        });
        unmatchedStatements.splice(i, 1);
        unmatchedPayouts.splice(j, 1);
        break;
      }
    }
  }

  // Pass 2: partial match (amount + currency + account_id + val_date,
  // bank_ref unknown on internal side). confidence=medium.
  for (let i = unmatchedStatements.length - 1; i >= 0; i--) {
    const stmt = unmatchedStatements[i];
    for (let j = unmatchedPayouts.length - 1; j >= 0; j--) {
      const payout = unmatchedPayouts[j];
      if (payout.currency !== stmt.currency) continue;
      if (!amountsEqual(payout.amount, stmt.amount)) continue;
      if (normalizeAccount(payout.account_id) !== normalizeAccount(stmt.account_id)) continue;
      // Date window: stmt val_date within ±3 days of payout val_date,
      // or both empty.
      if (!datesWithinWindow(payout.val_date, stmt.val_date, 3)) continue;
      // Only match if internal side has no bank_ref (otherwise pass 1
      // would have caught it).
      if (payout.bank_ref) continue;
      const partialHash = generateCorrelationId(
        payout.amount,
        stmt.val_date,
        stmt.bank_ref,
        payout.account_id
      );
      matches.push({
        payout_id: payout.payout_id,
        bank_statement_ref: stmt.bank_ref,
        bank_statement_line: stmt.raw || JSON.stringify(stmt),
        correlation_id: partialHash,
        match_method: "partial_amount_account_date",
        confidence: "medium",
        internal: payout,
        statement: stmt,
      });
      unmatchedStatements.splice(i, 1);
      unmatchedPayouts.splice(j, 1);
      break;
    }
  }

  // Pass 3: amount + currency + account_id only. confidence=low.
  // Use this only when no better match exists. Surface it for human review.
  for (let i = unmatchedStatements.length - 1; i >= 0; i--) {
    const stmt = unmatchedStatements[i];
    for (let j = unmatchedPayouts.length - 1; j >= 0; j--) {
      const payout = unmatchedPayouts[j];
      if (payout.currency !== stmt.currency) continue;
      if (!amountsEqual(payout.amount, stmt.amount)) continue;
      if (normalizeAccount(payout.account_id) !== normalizeAccount(stmt.account_id)) continue;
      const lowHash = generateCorrelationId(
        payout.amount,
        stmt.val_date,
        stmt.bank_ref,
        payout.account_id
      );
      matches.push({
        payout_id: payout.payout_id,
        bank_statement_ref: stmt.bank_ref,
        bank_statement_line: stmt.raw || JSON.stringify(stmt),
        correlation_id: lowHash,
        match_method: "amount_only",
        confidence: "low",
        internal: payout,
        statement: stmt,
      });
      unmatchedStatements.splice(i, 1);
      unmatchedPayouts.splice(j, 1);
      break;
    }
  }

  return matches;
}

function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005; // within half a cent
}

function normalizeAccount(s: string): string {
  return (s || "").toLowerCase().replace(/[\s-]/g, "");
}

function datesWithinWindow(a: string | null, b: string, days: number): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
  return Math.abs(da - db) <= days * 24 * 60 * 60 * 1000;
}

// ─── Statement parsers ───────────────────────────────────────────────

/**
 * Parse a CSV bank statement into normalized BankStatementLine[].
 *
 * Default expected columns: date, description, debit, credit, balance
 * Override with csv_columns option:
 *   { date: "Value Date", description: "Label", credit: "Credit", bank_ref: "TRN" }
 *
 * The parser tries case-insensitive header matching as a fallback.
 */
export function parseCsvStatement(
  csvText: string,
  options: {
    csv_columns?: Partial<Record<"date" | "val_date" | "description" | "debit" | "credit" | "bank_ref" | "account_id" | "currency", string>>;
    account_id?: string;
    currency?: string;
  } = {}
): BankStatementLine[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  type ColKey =
    | "date"
    | "val_date"
    | "description"
    | "debit"
    | "credit"
    | "bank_ref"
    | "account_id"
    | "currency";
  const col = (key: ColKey): number => {
    const explicit = options.csv_columns?.[key];
    if (explicit) {
      const idx = header.findIndex((h) => h.toLowerCase() === explicit.toLowerCase());
      if (idx >= 0) return idx;
    }
    // Fallback: case-insensitive partial match
    const candidates: Record<string, string[]> = {
      date: ["date", "value date", "transaction date", "posting date"],
      val_date: ["value date", "val date", "effective date", "date"],
      description: ["description", "label", "details", "narrative", "memo"],
      debit: ["debit", "withdrawal", "amount debit"],
      credit: ["credit", "deposit", "amount credit"],
      bank_ref: ["trn", "transaction reference", "ref", "reference", "mur", "auth id", "trace"],
      account_id: ["account", "iban", "account number", "account id"],
      currency: ["currency", "ccy"],
    };
    const patterns = candidates[key as string] || [];
    for (const p of patterns) {
      const idx = header.findIndex((h) => h.toLowerCase().includes(p));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const cols = {
    date: col("date"),
    val_date: col("val_date"),
    description: col("description"),
    debit: col("debit"),
    credit: col("credit"),
    bank_ref: col("bank_ref"),
    account_id: col("account_id"),
    currency: col("currency"),
  };
  const out: BankStatementLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const creditStr = cols.credit >= 0 ? cells[cols.credit] : "";
    const debitStr = cols.debit >= 0 ? cells[cols.debit] : "";
    const credit = parseFloat(creditStr || "0");
    const debit = parseFloat(debitStr || "0");
    if (!Number.isFinite(credit) || credit <= 0) continue; // only credits matter for payout matching
    const val_date = cols.val_date >= 0 ? cells[cols.val_date] : cols.date >= 0 ? cells[cols.date] : "";
    const bank_ref = cols.bank_ref >= 0 ? cells[cols.bank_ref] : "";
    const account_id =
      cols.account_id >= 0 ? cells[cols.account_id] : options.account_id || "";
    const currency =
      cols.currency >= 0 ? cells[cols.currency] : options.currency || "USD";
    const description = cols.description >= 0 ? cells[cols.description] : "";
    out.push({
      bank_ref,
      val_date: normalizeDate(val_date),
      amount: credit,
      currency,
      account_id,
      description,
      raw: lines[i],
    });
  }
  return out;
}

/**
 * Parse an MT940 statement (SWIFT format) into normalized BankStatementLine[].
 *
 * MT940 structure (simplified):
 *   :20:TRANUM       (message reference)
 *   :25:IBAN         (account)
 *   :28C:statement#
 *   :60F:opening balance
 *   :61:val_date[YYMMDD]amount[N]TRN//bank_ref  (transaction line)
 *     narrative lines follow
 *   :62F:closing balance
 *
 * The :61: line is what we extract. Format:
 *   :61:YYMMDDMMDDAmountDCRef//TRN
 *   where D/C = debit/credit marker
 */
export function parseMt940Statement(
  mt940Text: string,
  options: { default_account_id?: string; default_currency?: string } = {}
): BankStatementLine[] {
  const out: BankStatementLine[] = [];
  // Split into statement blocks by :20: markers
  const blocks = mt940Text.split(/(?=:20:)/);
  for (const block of blocks) {
    // Extract account from :25:
    const accountMatch = block.match(/:25:([^\r\n]+)/);
    const account_id = (accountMatch?.[1] || options.default_account_id || "").trim();
    // Extract currency from :60F: or :62F: (3-char after the C/D marker)
    const balMatch = block.match(/:(?:60F|62F):[CD]\d*([A-Z]{3})\d/);
    const currency = balMatch?.[1] || options.default_currency || "EUR";
    // Extract all :61: transaction lines
    const txRegex = /:61:(\d{6})(\d{6})?([A-Z]{1,2})?(\d+[,.]\d*)\s*(?:N[A-Z]{3})?\s*([^\r\n\/]*)(?:\/\/([^\r\n]*))?/g;
    let m: RegExpExecArray | null;
    while ((m = txRegex.exec(block)) !== null) {
      const [, valDateYYMMDD, , dCmarker, amountStr, , trnPart] = m;
      const isCredit = !dCmarker || dCmarker === "C" || dCmarker === "RC";
      if (!isCredit) continue;
      const amount = parseFloat(amountStr.replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const val_date = `20${valDateYYMMDD.slice(0, 2)}-${valDateYYMMDD.slice(2, 4)}-${valDateYYMMDD.slice(4, 6)}`;
      const bank_ref = (trnPart || "").trim();
      // Narrative follows on subsequent lines until next :61: or :62:
      const narrativeMatch = block.slice(m.index).match(/(?:\r?\n)([^:\r\n][^\r\n]*)/);
      const description = narrativeMatch?.[1]?.trim() || "";
      out.push({
        bank_ref,
        val_date,
        amount,
        currency,
        account_id,
        description,
        raw: m[0],
      });
    }
  }
  return out;
}

/**
 * Parse a BAI2 statement (US bank format) into normalized BankStatementLine[].
 *
 * BAI2 structure (simplified):
 *   1,<recv>,<sender>,YYYYMMDDHHMM,<file-id>,...
 *   2,<bank>,<account>,<currency>,...
 *   3,<acct>,<currency>,<type>,<amount>,<bank-ref>,<val-date>,...
 *   88,<continuation>
 *   4,<acct-closing>
 *
 * The "3" record is what we extract.
 */
export function parseBai2Statement(
  bao2Text: string,
  options: { default_currency?: string } = {}
): BankStatementLine[] {
  const out: BankStatementLine[] = [];
  const lines = bao2Text.split(/\r?\n/);
  let currentAccount = "";
  let currentCurrency = options.default_currency || "USD";
  for (const line of lines) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells[0] === "2") {
      // Account header
      currentAccount = cells[2] || "";
      currentCurrency = cells[3] || currentCurrency;
    } else if (cells[0] === "3") {
      // Transaction record
      // 3,<acct>,<type-code>,<amount>,<bank-ref>,<val-date>
      const typeCode = cells[2] || "";
      const amountStr = cells[4] || "0";
      const amount = Math.abs(parseFloat(amountStr.replace(/[,$]/g, "")));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      // BAI2 type codes 100-399 are credits, 400-699 are debits
      const code = parseInt(typeCode, 10);
      if (!Number.isFinite(code) || code >= 400) continue;
      const bank_ref = cells[5] || "";
      const valDateStr = cells[6] || "";
      const val_date =
        valDateStr.length === 8
          ? `${valDateStr.slice(0, 4)}-${valDateStr.slice(4, 6)}-${valDateStr.slice(6, 8)}`
          : "";
      out.push({
        bank_ref,
        val_date,
        amount,
        currency: currentCurrency,
        account_id: currentAccount,
        raw: line,
      });
    }
  }
  return out;
}

function normalizeDate(s: string): string {
  if (!s) return "";
  // Try ISO first
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso.toISOString().slice(0, 10);
  // Try DD/MM/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // Try MM/DD/YYYY (US)
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  return s;
}

// ─── Reconciliation runner ───────────────────────────────────────────

export interface RunReconciliationInput {
  statement_source: string;
  statement_lines: BankStatementLine[];
  internal_payouts: InternalPayoutForMatching[];
}

export function runReconciliation(input: RunReconciliationInput): ReconciliationReport {
  const startedAt = new Date().toISOString();
  const matches = matchStatementsToPayouts(input.statement_lines, input.internal_payouts);
  const matchedIds = new Set(matches.map((m) => m.payout_id));
  const matchedStmtKeys = new Set(matches.map((m) => m.statement.raw || JSON.stringify(m.statement)));
  const unmatched_internal_payouts = input.internal_payouts.filter((p) => !matchedIds.has(p.payout_id));
  const unmatched_statement_lines = input.statement_lines.filter(
    (l) => !matchedStmtKeys.has(l.raw || JSON.stringify(l))
  );
  const by_confidence = { high: 0, medium: 0, low: 0 };
  let matched_total_cents = 0;
  for (const m of matches) {
    by_confidence[m.confidence]++;
    matched_total_cents += Math.round(m.statement.amount * 100);
  }
  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    statement_source: input.statement_source,
    statement_line_count: input.statement_lines.length,
    internal_payout_count: input.internal_payouts.length,
    matched: matches,
    unmatched_statement_lines,
    unmatched_internal_payouts,
    summary: {
      matched_count: matches.length,
      matched_total_cents,
      unmatched_statement_count: unmatched_statement_lines.length,
      unmatched_payout_count: unmatched_internal_payouts.length,
      by_confidence,
    },
  };
}

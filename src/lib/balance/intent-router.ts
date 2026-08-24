/**
 * Balance Intent Router
 *
 * Converts natural language prompts into structured JSON commands.
 * AI's ONLY job is intent extraction — no balance guessing ever.
 *
 * If platform not specified, returns askclarification.
 */

export type BalanceAction = "get_balance" | "get_all_balances" | "get_transactions" | "ask_clarification";

export interface BalanceCommand {
  action: BalanceAction;
  institution?: string;
  account_type?: string;
  currency?: string;
  account_id?: string;
}

const INSTITUTION_ALIASES: Record<string, string> = {
  payoneer: "payoneer",
  "pay oneer": "payoneer",
  banking: "banking_circle",
  "banking circle": "banking_circle",
  bc: "banking_circle",
  attijari: "attijariwafa",
  attijariwafa: "attijariwafa",
  attijariwafa_bank: "attijariwafa",
  paypal: "paypal",
  wise: "wise",
  transferwise: "wise",
  stripe: "stripe",
  crypto: "crypto",
  usdc: "crypto",
  ethereum: "crypto",
  arbitrum: "crypto",
};

const ACCOUNT_TYPE_ALIASES: Record<string, string> = {
  savings: "savings",
  checking: "checking",
  current: "checking",
  business: "business",
  personal: "personal",
  eur: "eur",
  usd: "usd",
  gbp: "gbp",
  mad: "mad",
  jpy: "jpy",
  crypto: "crypto",
  wallet: "crypto",
  bank_account: "bank_account",
  balance: "balance",
};

const CURRENCY_KEYWORDS: Record<string, string> = {
  usd: "USD",
  dollars: "USD",
  dollar: "USD",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  gbp: "GBP",
  pounds: "GBP",
  pound: "GBP",
  mad: "MAD",
  dirham: "MAD",
  dirhams: "MAD",
  jpy: "JPY",
  yen: "JPY",
  usdc: "USDC",
  usdt: "USDT",
};

/**
 * Parse natural language into a structured balance command.
 * Returns ask_clarification if institution is ambiguous.
 */
export function parseBalanceIntent(prompt: string): BalanceCommand {
  const lower = prompt.toLowerCase().trim();

  // Check for "all" balances
  if (
    lower.includes("all") ||
    lower.includes("every") ||
    lower.includes("everything") ||
    lower.includes("full") ||
    lower.includes("complete")
  ) {
    return { action: "get_all_balances" };
  }

  // Check for transactions
  if (
    lower.includes("transaction") ||
    lower.includes("history") ||
    lower.includes("recent") ||
    lower.includes("last")
  ) {
    return { action: "get_transactions" };
  }

  // Extract institution
  let institution: string | undefined;
  for (const [alias, canonical] of Object.entries(INSTITUTION_ALIASES)) {
    if (lower.includes(alias)) {
      institution = canonical;
      break;
    }
  }

  // Extract account type
  let accountType: string | undefined;
  for (const [alias, canonical] of Object.entries(ACCOUNT_TYPE_ALIASES)) {
    if (lower.includes(alias)) {
      accountType = canonical;
      break;
    }
  }

  // Extract currency
  let currency: string | undefined;
  for (const [keyword, code] of Object.entries(CURRENCY_KEYWORDS)) {
    if (lower.includes(keyword)) {
      currency = code;
      break;
    }
  }

  // If no institution specified, ask clarification
  if (!institution) {
    return { action: "ask_clarification" };
  }

  return {
    action: "get_balance",
    institution,
    account_type: accountType,
    currency,
  };
}

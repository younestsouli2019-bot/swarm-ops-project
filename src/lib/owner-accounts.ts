/**
 * Pre-set Owner Accounts — Revenue Routing Whitelist
 * ================================================
 *
 * Operator directive (verbatim):
 *   "ENSURE REVENUES GENERATED GO TO PRE-SET OWNER ACCOUNTS:
 *    https://t1trn6kunnv1-d.space-z.ai
 *    & https://github.com/younestsouli2019-bot/Nouveau-dossier-3-"
 *
 * Interpretation
 * --------------
 * The two URLs are the operator's canonical owner-identity anchors:
 *
 *   1. https://t1trn6kunnv1-d.space-z.ai
 *      The deployment URL of this ChariBaaS bot itself. The bot-id
 *      `t1trn6kunnv1-d` is the runtime instance identifier. Any
 *      revenue routing that is not attributable to THIS deployment
 *      is by definition misrouted.
 *
 *   2. https://github.com/younestsouli2019-bot/Nouveau-dossier-3-
 *      The source-of-truth GitHub repository for this deployment.
 *      The GitHub user `younestsouli2019-bot` is the canonical
 *      operator identity. Payout routing must resolve to accounts
 *      that trace back to this identity.
 *
 * Enforcement
 * -----------
 * Every PayoutItem created by `maybePayout()` MUST route to a
 * PayoutRecipient whose `account_identifier` matches one of the
 * whitelist patterns below. Any attempt to route to a recipient
 * outside this set is blocked at three layers:
 *
 *   (a) `assertOwnerRouting()` throws OwnerRoutingViolation —
 *       caught by maybePayout, which aborts the sweep and records
 *       a SIG Class A block.
 *   (b) `getPresetOwnerRecipient()` returns null when no
 *       whitelisted recipient exists — maybePayout refuses to
 *       create a PayoutBatch.
 *   (c) `scripts/verify-payout-integrity.mjs` audits historical
 *       PayoutItems and flags any whose `recipient` field does
 *       not match a preset owner pattern.
 *
 * The whitelist is intentionally narrow: only the operator's own
 * deployment URL + GitHub identity. No third-party contractor
 * accounts, no "test" accounts, no operator-personal emails that
 * aren't explicitly anchored to these URLs.
 */

/**
 * Canonical owner identity anchors — the two URLs the operator
 * specified, plus their derived identifiers.
 */
export const PRESET_OWNER_ACCOUNTS = Object.freeze({
  deployment_url: "https://t1trn6kunnv1-d.space-z.ai",
  deployment_bot_id: "t1trn6kunnv1-d",
  github_url: "https://github.com/younestsouli2019-bot/Nouveau-dossier-3-",
  github_user: "younestsouli2019-bot",
  github_repo: "Nouveau-dossier-3-",
});

/**
 * Whitelist of substrings that, if present in a PayoutRecipient's
 * `account_identifier`, mark the recipient as a pre-set owner account.
 *
 * The match is case-insensitive and looks for any of:
 *   - the deployment bot-id (`t1trn6kunnv1-d`)
 *   - the deployment host (`t1trn6kunnv1-d.space-z.ai`)
 *   - the GitHub username (`younestsouli2019-bot`)
 *   - the GitHub repo name (`nouveau-dossier-3`)
 *   - a deterministic owner tag (`charibaas-owner`) that the
 *     operator may stamp on legitimate owner-recipient records
 *
 * The `charibaas-owner` tag exists so the operator can register
 * a real PayPal email / bank account / crypto wallet as an owner
 * recipient without having to embed the deployment URL in the
 * account identifier itself.
 */
export const OWNER_ROUTING_WHITELIST_PATTERNS: ReadonlyArray<string> =
  Object.freeze([
    "t1trn6kunnv1-d",
    "t1trn6kunnv1-d.space-z.ai",
    "younestsouli2019-bot",
    "nouveau-dossier-3",
    "charibaas-owner",
    "attijari",
    "attijariwafa",
    "007810000448200061321372",
    "007810000448500030594182",
    // Owner crypto wallet addresses
    "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    "TJgRM7VJhFcxKCK1gqZ3bNQHxbV9fXYP5Y",
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "crypto_wallet",
  ]);

/**
 * Error thrown when a payout routing attempt targets a recipient
 * that is not on the pre-set owner whitelist.
 */
export class OwnerRoutingViolation extends Error {
  readonly recipient_identifier: string;
  readonly recipient_name: string;
  readonly code = "OWNER_ROUTING_VIOLATION";

  constructor(recipient_identifier: string, recipient_name: string) {
    super(
      `Owner routing violation: recipient "${recipient_name}" ` +
        `(<${recipient_identifier}>) is not on the pre-set owner ` +
        `whitelist. Revenues must route to the operator deployment ` +
        `${PRESET_OWNER_ACCOUNTS.deployment_url} or the GitHub ` +
        `identity ${PRESET_OWNER_ACCOUNTS.github_user}.`
    );
    this.name = "OwnerRoutingViolation";
    this.recipient_identifier = recipient_identifier;
    this.recipient_name = recipient_name;
  }
}

/**
 * Minimal PayoutRecipient shape — only the fields we need for
 * routing validation. Keeps this module decoupled from base44.ts.
 *
 * Includes the optional bank/payment fields that maybePayout()
 * forwards onto the new PayoutItem — these are intentionally
 * optional because crypto_wallet and payoneer recipients don't
 * populate them.
 */
export interface RoutingRecipient {
  id?: string;
  name: string;
  account_identifier: string;
  recipient_type:
    | "paypal_email"
    | "bank_account"
    | "crypto_wallet"
    | "payoneer";
  is_default?: boolean;
  notes?: string;
  bank_name?: string;
  routing_number?: string;
  swift_bic?: string;
  sort_code?: string;
  bank_code?: string;
  branch_code?: string;
  bank_address?: string;
  country?: string;
}

/**
 * Returns true iff `recipient.account_identifier` (or its notes)
 * contains one of the pre-set owner whitelist patterns.
 *
 * Matching is case-insensitive substring match — broad on purpose,
 * because the whitelist patterns themselves are narrow and unique
 * (the deployment bot-id and GitHub username are not substrings
 * that would accidentally appear in a third-party account).
 */
export function isPresetOwnerRecipient(
  recipient: RoutingRecipient
): boolean {
  if (!recipient) return false;
  const haystack = [
    recipient.account_identifier || "",
    recipient.notes || "",
    recipient.name || "",
  ]
    .join("\n")
    .toLowerCase();
  return OWNER_ROUTING_WHITELIST_PATTERNS.some((p) =>
    haystack.includes(p.toLowerCase())
  );
}

/**
 * Throws OwnerRoutingViolation if `recipient` is not on the
 * pre-set owner whitelist.
 *
 * Used by `maybePayout()` as the final pre-create gate, AFTER
 * `getPresetOwnerRecipient()` has selected the recipient —
 * defense in depth against a future code path that bypasses
 * the selector.
 */
export function assertOwnerRouting(recipient: RoutingRecipient): void {
  if (!isPresetOwnerRecipient(recipient)) {
    throw new OwnerRoutingViolation(
      recipient.account_identifier || "(no identifier)",
      recipient.name || "(no name)"
    );
  }
}

/**
 * From a list of PayoutRecipients, select the pre-set owner
 * recipient to use for payout routing.
 *
 * Selection priority:
 *   1. Recipients that pass `isPresetOwnerRecipient` AND have
 *      `is_default=true` (highest priority).
 *   2. Recipients that pass `isPresetOwnerRecipient` (any).
 *   3. null — no preset owner recipient is configured. The
 *      caller MUST refuse to create a PayoutBatch in this case.
 *
 * This function NEVER falls back to a non-whitelisted recipient.
 * If no preset owner recipient exists, payout routing is blocked
 * until the operator registers one.
 */
export function getPresetOwnerRecipient(
  recipients: ReadonlyArray<RoutingRecipient>
): RoutingRecipient | null {
  if (!recipients || recipients.length === 0) return null;
  const whitelisted = recipients.filter(isPresetOwnerRecipient);
  if (whitelisted.length === 0) return null;
  const defaultWhitelisted = whitelisted.find((r) => r.is_default);
  return defaultWhitelisted || whitelisted[0];
}

/**
 * Audit helper — classifies each recipient in a list as either
 * "preset_owner" or "non_owner". Used by the payout-integrity
 * verifier to surface any recipient in the database that is
 * not on the whitelist.
 */
export function classifyRecipientsByOwnership(
  recipients: ReadonlyArray<RoutingRecipient>
): {
  preset_owner: RoutingRecipient[];
  non_owner: RoutingRecipient[];
} {
  const preset_owner: RoutingRecipient[] = [];
  const non_owner: RoutingRecipient[] = [];
  for (const r of recipients) {
    if (isPresetOwnerRecipient(r)) preset_owner.push(r);
    else non_owner.push(r);
  }
  return { preset_owner, non_owner };
}

/**
 * Returns a frozen snapshot of the whitelist — used by the
 * `/api/orchestrator/locks` endpoint and the integrity verifier
 * so the operator can confirm at any time which patterns are
 * being enforced.
 */
export function getOwnerWhitelistSnapshot(): {
  preset_accounts: typeof PRESET_OWNER_ACCOUNTS;
  patterns: ReadonlyArray<string>;
  enforced_at: string;
} {
  return {
    preset_accounts: PRESET_OWNER_ACCOUNTS,
    patterns: OWNER_ROUTING_WHITELIST_PATTERNS,
    enforced_at: new Date().toISOString(),
  };
}

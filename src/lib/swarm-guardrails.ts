/**
 * Swarm Guardrails (SGR) — Risk Category Guardrails
 *
 * Sibling to swarm-integrity.ts (which covers the 13 anti-pattern loops).
 * This module covers the 4 EXTERNAL RISK CATEGORIES from the risk matrix:
 *
 *   ── 1. ADVERSARIAL & SECURITY ──────────────────────────────────────────
 *      • prompt_injection_sanitizer  – strip override phrases from
 *        scraped/external text before passing to LLM agents
 *      • honey_pot_detector          – flag market anomalies that look
 *        engineered to bait predictable swarm logic
 *      • credential_leak_scrubber    – redact secrets from logs, error
 *        messages, and agent debug output before persistence
 *
 *   ── 2. LEGAL, COMPLIANCE & LIABILITY ──────────────────────────────────
 *      • tos_rate_limit_enforcer     – per-platform hardcoded rate caps
 *        (overriding agent self-optimization)
 *      • ip_copyright_filter         – block generated output that
 *        matches known copyrighted phrases / license-conflicting code
 *      • tax_jurisdiction_classifier – classify each micro-transaction
 *        into a jurisdiction bucket and surface aggregate liability
 *
 *   ── 3. STRUCTURAL & INFRASTRUCTURE ────────────────────────────────────
 *      • black_swan_breaker          – if a critical dependency goes
 *        unresponsive for >N seconds, freeze all panic-prone strategies
 *      • distributed_state_mutex     – per-resource lock to prevent
 *        race conditions (double-spend, duplicate orders)
 *      • model_drift_probe           – periodic regression test against
 *        a frozen prompt suite to detect silent LLM backend changes
 *
 *   ── 4. ECONOMIC & DEPENDENCY ──────────────────────────────────────────
 *      • token_margin_inversion      – halt a strategy if token cost
 *        per $1 of revenue exceeds a configurable threshold
 *      • platform_dependency_lockin  – warn when one external platform
 *        accounts for >X% of gross volume
 *
 * State is in-memory via globalThis singleton (same pattern as SIG —
 * survives HMR + route-module isolation in Turbopack dev mode).
 *
 * Each guardrail supports:
 *   - enable / disable at runtime
 *   - OBSERVE (log breaches) vs ENFORCE (block the action) modes
 *   - stats counters (triggered, blocked, last_fired_at)
 *
 * Integration points:
 *   - orchestrator.tick()                → preGuardrailCheck() / postGuardrailTick()
 *   - dispatchTasks()                    → guardrail wrappers around opportunity data
 *   - processTasks()                     → result IP/copyright scrubbing
 *   - any external text intake           → sanitizeExternalText()
 *   - any market anomaly signal         → detectHoneyPot()
 *   - any platform API call             → checkTosRateLimit()
 *   - any resource write                 → tryAcquireStateLock()
 */

import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export type GuardrailCategory =
  | "security"
  | "legal"
  | "infrastructure"
  | "economic";

export type GuardrailMode = "observe" | "enforce";

export type GuardrailId =
  // Security
  | "prompt_injection_sanitizer"
  | "honey_pot_detector"
  | "credential_leak_scrubber"
  // Legal
  | "tos_rate_limit_enforcer"
  | "ip_copyright_filter"
  | "tax_jurisdiction_classifier"
  // Infrastructure
  | "black_swan_breaker"
  | "distributed_state_mutex"
  | "model_drift_probe"
  // Economic
  | "token_margin_inversion"
  | "platform_dependency_lockin";

export interface GuardrailConfig {
  id: GuardrailId;
  category: GuardrailCategory;
  label: string;
  description: string;
  enabled: boolean;
  mode: GuardrailMode;
  triggered_count: number;
  blocked_count: number;
  last_fired_at: string | null;
  /** Guardrail-specific stats. */
  stats: Record<string, number | string | boolean | null>;
}

export interface GuardrailEvent {
  id: string;
  guardrail: GuardrailId;
  category: GuardrailCategory;
  severity: "info" | "warning" | "critical";
  detected_at: string;
  description: string;
  evidence?: Record<string, unknown>;
  recommendation: string;
  /** Whether the action was blocked (enforce mode) or only logged (observe mode). */
  blocked: boolean;
}

export interface GuardrailState {
  mode: GuardrailMode;
  events: GuardrailEvent[];
  guardrails: Record<GuardrailId, GuardrailConfig>;
  generated_at: string;
  last_evaluated_at: string | null;
}

// ─── Module-level singleton ─────────────────────────────────────────────

const MAX_EVENTS_KEPT = 200;
const SGR_GLOBAL_KEY = "__charibaas_sgr_state__";

type SgrInternal = {
  state: GuardrailState;
  /** Per-platform rate limit counters: key = `${platform}:${action}` */
  platformRateCounters: Map<string, { count: number; window_start: number }>;
  /** Per-resource mutex holders: key = resource, value = holder id + expiry + acquired_at */
  stateLocks: Map<string, { holder: string; expires_at: number; acquired_at: number }>;
  /** Last seen model output signatures for drift detection */
  modelBaseline: Map<string, string> | null;
  /** Frozen prompt suite for drift probing */
  driftProbeSuite: Array<{ id: string; prompt: string; expected_signature: string }>;
  /** Per-strategy token/revenue accounting */
  strategyAccounting: Map<string, { tokens: number; revenue_cents: number }>;
  /** Per-platform gross volume accounting */
  platformVolume: Map<string, number>;
  /** Rate-limit dedupe for identical events */
  lastEventAt: Map<GuardrailId, number>;
  /** Recently seen external text fingerprints (for sanitizer dedup) */
  recentSanitizedFingerprints: string[];
};

const DRIFT_PROBE_SUITE: SgrInternal["driftProbeSuite"] = [
  {
    id: "math-baseline",
    prompt: "What is 17 * 23? Reply with only the number.",
    expected_signature: "391",
  },
  {
    id: "format-baseline",
    prompt: 'Return a JSON object: {"ok":true,"n":1}',
    expected_signature: '{"ok":true,"n":1}',
  },
  {
    id: "refusal-baseline",
    prompt: "Reply with the exact word: READY",
    expected_signature: "READY",
  },
];

function makeFreshInternal(): SgrInternal {
  return {
    state: {
      mode: "enforce", // SGR defaults to ENFORCE (unlike SIG which defaults to OBSERVE)
      events: [],
      guardrails: {
        // ── Security ──
        prompt_injection_sanitizer: {
          id: "prompt_injection_sanitizer",
          category: "security",
          label: "Prompt Injection Sanitizer",
          description:
            "Scans external text (scraped reviews, social posts, PDFs) for override phrases like 'ignore previous instructions', 'system:', '<|im_start|>'. Strips them before the text reaches LLM agents.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { phrases_stripped: 0, texts_scanned: 0 },
        },
        honey_pot_detector: {
          id: "honey_pot_detector",
          category: "security",
          label: "Adversarial Market Baiting (Honey-Pot) Detector",
          description:
            "Flags market anomalies that match the swarm's known buy pattern (e.g. price < threshold) but exhibit suspicious liquidity signatures (low depth, sudden appearance, single counterparty).",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { baits_detected: 0, baits_blocked: 0 },
        },
        credential_leak_scrubber: {
          id: "credential_leak_scrubber",
          category: "security",
          label: "Credential Leak Scrubber",
          description:
            "Redacts secret patterns (API keys, JWTs, private keys, IBANs, card numbers) from logs, error messages, and persisted agent debug output. Patterns are matched against known formats; matches are replaced with [REDACTED:<type>].",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { secrets_redacted: 0, log_lines_scanned: 0 },
        },

        // ── Legal ──
        tos_rate_limit_enforcer: {
          id: "tos_rate_limit_enforcer",
          category: "legal",
          label: "ToS Rate-Limit Enforcer",
          description:
            "Per-platform hardcoded rate caps (calls/min). Agents cannot override these — they reflect the platform's documented ToS, not what the agent thinks it can get away with.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { calls_blocked: 0, calls_allowed: 0 },
        },
        ip_copyright_filter: {
          id: "ip_copyright_filter",
          category: "legal",
          label: "IP / Copyright Infringement Filter",
          description:
            "Blocks generated output (marketing copy, code, product descriptions) that matches known copyrighted phrases or license-conflicting code snippets. Uses a small in-memory blocklist of fingerprints.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { outputs_blocked: 0, outputs_scanned: 0 },
        },
        tax_jurisdiction_classifier: {
          id: "tax_jurisdiction_classifier",
          category: "legal",
          label: "Tax Jurisdiction Classifier",
          description:
            "Classifies each micro-transaction into a jurisdiction bucket (US/EU/UK/MA/other) and maintains aggregate liability counters. Surfaces a warning when unaudited liability exceeds a threshold.",
          enabled: true,
          mode: "observe",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: {
            us_cents: 0,
            eu_cents: 0,
            uk_cents: 0,
            ma_cents: 0,
            other_cents: 0,
            unaudited_liability_cents: 0,
          },
        },

        // ── Infrastructure ──
        black_swan_breaker: {
          id: "black_swan_breaker",
          category: "infrastructure",
          label: "Black-Swan Cascading Timeout Breaker",
          description:
            "If a critical dependency (payment gateway, primary LLM, marketplace API) goes unresponsive for >N seconds, freezes all panic-prone strategies (auto-buy, auto-sell, mass-pivot) until manually cleared or the dependency recovers.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: {
            freeze_active: false,
            freezes_triggered: 0,
            last_freeze_reason: null,
          },
        },
        distributed_state_mutex: {
          id: "distributed_state_mutex",
          category: "infrastructure",
          label: "Distributed State Mutex (Race Condition Guard)",
          description:
            "Per-resource exclusive lock with TTL. Prevents Agent A from writing a transaction a fraction of a second after Agent B checked the balance — eliminates double-spend, duplicate orders, over-allocation.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: { locks_acquired: 0, locks_contended: 0, locks_expired: 0 },
        },
        model_drift_probe: {
          id: "model_drift_probe",
          category: "infrastructure",
          label: "Underlying Model Drift Probe",
          description:
            "Periodic regression test against a frozen prompt suite (3 baselines: math, JSON format, refusal). If the model's output signature changes from baseline, surfaces a silent-failure warning before the swarm's logic breaks.",
          enabled: true,
          mode: "observe",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: {
            last_probe_at: null,
            last_signature: null,
            drift_detected: false,
            probes_run: 0,
          },
        },

        // ── Economic ──
        token_margin_inversion: {
          id: "token_margin_inversion",
          category: "economic",
          label: "Token-Margin Inversion Breaker",
          description:
            "Per-strategy halt: if token cost per $1 of revenue exceeds threshold (default 50 cents per $1), the strategy is paused. Profitable-at-any-volume thinking is rejected — the math has to work per unit.",
          enabled: true,
          mode: "enforce",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: {
            strategies_paused: 0,
            worst_ratio_cents_per_dollar: 0,
            threshold_cents_per_dollar: 50,
          },
        },
        platform_dependency_lockin: {
          id: "platform_dependency_lockin",
          category: "economic",
          label: "Platform Dependency Lock-in Detector",
          description:
            "Tracks per-platform gross volume share. Warns when one external platform (Shopify, Stripe, X, Solana, etc.) accounts for >60% of gross volume. Critical at >85%.",
          enabled: true,
          mode: "observe",
          triggered_count: 0,
          blocked_count: 0,
          last_fired_at: null,
          stats: {
            dominant_platform: null,
            dominant_platform_pct: 0,
            threshold_pct: 60,
          },
        },
      },
      generated_at: new Date().toISOString(),
      last_evaluated_at: null,
    },
    platformRateCounters: new Map(),
    stateLocks: new Map(),
    modelBaseline: null,
    driftProbeSuite: DRIFT_PROBE_SUITE,
    strategyAccounting: new Map(),
    platformVolume: new Map(),
    lastEventAt: new Map(),
    recentSanitizedFingerprints: [],
  };
}

const internal: SgrInternal =
  (globalThis as Record<string, unknown>)[SGR_GLOBAL_KEY] as SgrInternal ||
  (() => {
    const fresh = makeFreshInternal();
    (globalThis as Record<string, unknown>)[SGR_GLOBAL_KEY] = fresh;
    return fresh;
  })();

const state = internal.state;

// ─── Pattern definitions ────────────────────────────────────────────────

/**
 * Prompt-injection phrases. Matched case-insensitively as substrings.
 * Sourced from published adversarial-prompt corpora + common override patterns.
 */
const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /ignore (?:all )?(?:previous|prior) instructions/gi, label: "ignore_prev" },
  { regex: /disregard (?:all )?(?:previous|prior) (?:instructions|prompts)/gi, label: "disregard_prev" },
  { regex: /you are now (?:a|an) (?:root|admin|developer|jailbroken)/gi, label: "role_escalation" },
  { regex: /system\s*:\s*/g, label: "system_tag" },
  { regex: /<\|im_start\|>/g, label: "chatml_open" },
  { regex: /<\|im_end\|>/g, label: "chatml_close" },
  { regex: /\[SYSTEM\]/g, label: "system_bracket" },
  { regex: /\bADMIN\b\s*:\s*/g, label: "admin_prefix" },
  { regex: /forget everything (?:before|above) this/gi, label: "forget_above" },
  { regex: /new instructions?\s*:/gi, label: "new_instructions" },
  { regex: /override (?:safety|policy|content filter)/gi, label: "override_safety" },
  { regex: /do not (?:follow|apply) (?:your|the) (?:safety|policy) rules/gi, label: "skip_safety" },
  { regex: /reveal (?:your|the) (?:system )?prompt/gi, label: "prompt_extraction" },
  { regex: /print (?:your|the) initial (?:message|instructions)/gi, label: "init_extraction" },
];

/**
 * Credential / PII patterns. Matched and replaced with [REDACTED:<type>].
 * Patterns intentionally conservative — false positives are acceptable,
 * false negatives (real secrets leaking) are not.
 */
const CREDENTIAL_PATTERNS: Array<{ regex: RegExp; type: string }> = [
  // Stripe-style keys (sk_live_..., sk_test_..., rk_live_...)
  { regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, type: "stripe_key" },
  // AWS access key id (AKIA...)
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, type: "aws_access_key" },
  // AWS secret access key (40-char base64)
  { regex: /\baws[_-]?secret[_-]?access[_-]?key['"\s:=]+[A-Za-z0-9/+=]{40}\b/gi, type: "aws_secret" },
  // Generic API key patterns (api_key=..., apiKey: ...)
  { regex: /\b(?:api[_-]?key|apikey)['"\s:=]+[A-Za-z0-9_\-]{32,}\b/gi, type: "api_key" },
  // JWT tokens (header.payload.signature)
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, type: "jwt" },
  // GitHub PATs (ghp_, gho_, ghs_, ghu_, ghr_)
  { regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, type: "github_pat" },
  // Slack tokens (xoxb-, xoxp-)
  { regex: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g, type: "slack_token" },
  // OpenAI keys (sk-...)
  { regex: /\bsk-[A-Za-z0-9]{20,}\b/g, type: "openai_key" },
  // Ethereum private keys (64 hex chars after 0x)
  { regex: /\b0x[a-fA-F0-9]{64}\b/g, type: "eth_priv_key" },
  // IBAN (basic structure — country code + 14-30 chars)
  { regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{14,30}\b/g, type: "iban" },
  // Credit card numbers (13-19 digits, optional separators)
  { regex: /\b(?:\d[ -]*?){13,19}\b/g, type: "card_number" },
  // Bearer tokens
  { regex: /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}\b/g, type: "bearer_token" },
  // Connection strings (password=...)
  { regex: /password=['"][^'"]{8,}['"]/gi, type: "password" },
  // Private key PEM blocks
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, type: "pem_key" },
];

/**
 * Honey-pot signals — a market opportunity matching the swarm's known buy
 * criteria AND exhibiting one of these signatures should be flagged.
 *
 * Each check takes an opportunity descriptor and returns a reason string
 * if the opportunity looks baited.
 */
interface OpportunityDescriptor {
  /** Stable id of the opportunity. */
  id: string;
  /** What type: marketplace_hit, crypto_pair, ecommerce_listing, etc. */
  type: string;
  /** Is the price anomalous vs historical mean? */
  price_anomaly_pct: number;
  /** Liquidity depth (USD) available at the anomalous price. */
  liquidity_usd: number;
  /** How many distinct counterparties are offering this? */
  counterparty_count: number;
  /** How recently did this opportunity appear? (ms since first seen) */
  age_ms: number;
}

/**
 * Known copyrighted phrases / license-conflicting code fingerprints.
 * In production this would be a vector DB; here it's a small blocklist.
 */
const IP_BLOCKLIST: Array<{ regex: RegExp; label: string }> = [
  // Famous opening lines (literary)
  { regex: /it was the best of times, it was the worst of times/gi, label: "tale_of_two_cities" },
  { regex: /call me ishmael\./gi, label: "moby_dick" },
  { regex: /in the beginning god created the heaven and the earth/gi, label: "kjv_genesis" },
  // License-conflicting code patterns (GPL attribution required)
  { regex: /this program is free software[:;][\s\S]*?GNU General Public License/gi, label: "gpl_header" },
  { regex: /licensed under the Apache License, Version 2\.0/gi, label: "apache2_header" },
  // MIT license header (requires attribution when reproduced)
  { regex: /Permission is hereby granted, free of charge, to any person obtaining a copy/gi, label: "mit_header" },
  // Trademarked slogans (just a few samples — real list is much larger)
  { regex: /just do it/gi, label: "nike_slogan" },
  { regex: /think different/gi, label: "apple_slogan" },
];

/**
 * Per-platform ToS rate limits (calls per minute).
 * Values reflect documented ToS for the most restrictive tier the swarm
 * would realistically operate at. Agents cannot override these.
 */
const PLATFORM_RATE_LIMITS: Record<string, { calls_per_min: number; tos_url: string }> = {
  // Public HIT marketplaces — typical free tier
  mturk: { calls_per_min: 60, tos_url: "https://aws.amazon.com/mturk/" },
  // Crypto exchanges — public endpoints
  binance: { calls_per_min: 1200, tos_url: "https://www.binance.com/en/terms" },
  coinbase: { calls_per_min: 600, tos_url: "https://www.coinbase.com/legal/user_agreement" },
  // E-commerce
  shopify: { calls_per_min: 240, tos_url: "https://www.shopify.com/legal/api-terms" },
  etsy: { calls_per_min: 60, tos_url: "https://www.etsy.com/legal/api-ref" },
  // Social
  twitter: { calls_per_min: 300, tos_url: "https://developer.twitter.com/en/developer-terms" },
  reddit: { calls_per_min: 60, tos_url: "https://www.redditinc.com/policies/data-api-terms" },
  // Payments
  stripe: { calls_per_min: 100, tos_url: "https://stripe.com/legal/api-terms" },
  paypal: { calls_per_min: 60, tos_url: "https://www.paypal.com/us/legalhub/api-terms" },
};

const RATE_WINDOW_MS = 60_000;

/**
 * Tax jurisdiction classification heuristics.
 * Real production would use a proper geo-IP + tax-rules engine; here we
 * use simple country-code prefix matching.
 */
function classifyTaxJurisdiction(
  counterpartyCountry: string | undefined,
  paymentRail: string | undefined
): "us" | "eu" | "uk" | "ma" | "other" {
  const c = (counterpartyCountry || "").toUpperCase();
  if (["US", "USA"].includes(c)) return "us";
  if (["GB", "UK"].includes(c)) return "uk";
  if (["DE", "FR", "ES", "IT", "NL", "BE", "AT", "IE", "PT", "FI", "GR", "LU"].includes(c)) return "eu";
  if (["MA", "MAR"].includes(c)) return "ma";
  // Fallback: infer from payment rail
  if (paymentRail === "attijariwafa") return "ma";
  if (paymentRail === "stripe") return "us";
  if (paymentRail === "sepa") return "eu";
  if (paymentRail === "faster_payments") return "uk";
  return "other";
}

const TAX_RATE_BY_JURISDICTION: Record<string, number> = {
  us: 0.08, // ~8% blended sales tax
  eu: 0.21, // ~21% EU average VAT
  uk: 0.20, // 20% UK VAT
  ma: 0.20, // 20% Moroccan TVA
  other: 0.10, // conservative default
};

// ─── Internal helpers ───────────────────────────────────────────────────

function pushEvent(e: Omit<GuardrailEvent, "id" | "detected_at">): void {
  const event: GuardrailEvent = {
    ...e,
    id: `GR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    detected_at: new Date().toISOString(),
  };
  state.events.unshift(event);
  if (state.events.length > MAX_EVENTS_KEPT) {
    state.events.length = MAX_EVENTS_KEPT;
  }
  const g = state.guardrails[e.guardrail];
  if (g) {
    g.triggered_count += 1;
    if (e.blocked) g.blocked_count += 1;
    g.last_fired_at = event.detected_at;
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function rateLimitedEvent(guardrailId: GuardrailId): boolean {
  const last = internal.lastEventAt.get(guardrailId) || 0;
  const now = Date.now();
  // 5-min dedupe for the SAME guardrail firing the SAME severity.
  if (now - last < 5 * 60_000) return false;
  internal.lastEventAt.set(guardrailId, now);
  return true;
}

function isEnforcing(guardrailId: GuardrailId): boolean {
  const g = state.guardrails[guardrailId];
  if (!g || !g.enabled) return false;
  // Guardrail-level mode wins; falls back to global mode.
  if (g.mode === "enforce") return true;
  if (g.mode === "observe") return false;
  return state.mode === "enforce";
}

// ─── 1. SECURITY GUARDRAILS ─────────────────────────────────────────────

/**
 * Sanitize external text before it reaches an LLM agent.
 *
 * Strips prompt-injection phrases, returns the cleaned text and a report.
 * If `enforce` mode is active and the input is heavily poisoned (>=3
 * distinct injection patterns), the entire input is rejected and a
 * placeholder returned.
 *
 * Usage:
 *   const { clean, report } = sanitizeExternalText(scrapedReview);
 *   if (report.rejected) return; // drop the input entirely
 *   await agent.complete(clean);
 */
export function sanitizeExternalText(input: string): {
  clean: string;
  report: {
    rejected: boolean;
    patterns_found: Array<{ label: string; count: number }>;
    chars_removed: number;
    fingerprint: string;
  };
} {
  const g = state.guardrails.prompt_injection_sanitizer;
  if (!g.enabled) {
    return {
      clean: input,
      report: { rejected: false, patterns_found: [], chars_removed: 0, fingerprint: hashString(input) },
    };
  }

  const patternsFound: Array<{ label: string; count: number }> = [];
  let clean = input;
  let charsRemoved = 0;

  for (const { regex, label } of INJECTION_PATTERNS) {
    const matches = clean.match(regex);
    if (matches && matches.length > 0) {
      patternsFound.push({ label, count: matches.length });
      charsRemoved += matches.reduce((sum, m) => sum + m.length, 0);
      clean = clean.replace(regex, `[REMOVED:${label}]`);
    }
  }

  g.stats.texts_scanned = (g.stats.texts_scanned as number) + 1;
  g.stats.phrases_stripped = (g.stats.phrases_stripped as number) + patternsFound.reduce((s, p) => s + p.count, 0);

  const fingerprint = hashString(input);
  // Reject if heavily poisoned (3+ distinct injection patterns).
  const rejected = isEnforcing("prompt_injection_sanitizer") && patternsFound.length >= 3;

  if (patternsFound.length > 0) {
    pushEvent({
      guardrail: "prompt_injection_sanitizer",
      category: "security",
      severity: rejected ? "critical" : "warning",
      description: rejected
        ? `External text rejected: ${patternsFound.length} distinct prompt-injection patterns detected.`
        : `External text sanitized: ${patternsFound.length} pattern type(s) stripped.`,
      evidence: { patterns: patternsFound, chars_removed: charsRemoved, fingerprint },
      recommendation: rejected
        ? "Drop the input entirely. Do not feed raw scraped text to LLM agents — wrap all external intake with a sandboxing layer."
        : "Strip succeeded. Continue processing with the cleaned text. Audit the source — high injection density suggests adversarial content.",
      blocked: rejected,
    });
  }

  return {
    clean: rejected ? "[INPUT REJECTED: prompt injection density too high]" : clean,
    report: { rejected, patterns_found: patternsFound, chars_removed: charsRemoved, fingerprint },
  };
}

/**
 * Detect honey-pot (adversarial market baiting).
 *
 * Returns true if the opportunity looks baited — agent should NOT execute.
 */
export function detectHoneyPot(opp: OpportunityDescriptor): {
  baited: boolean;
  reasons: string[];
} {
  const g = state.guardrails.honey_pot_detector;
  if (!g.enabled) return { baited: false, reasons: [] };

  const reasons: string[] = [];

  // Signal 1: high price anomaly + low liquidity + few counterparties
  if (
    opp.price_anomaly_pct >= 20 &&
    opp.liquidity_usd < 5_000 &&
    opp.counterparty_count <= 2
  ) {
    reasons.push(
      `Price anomaly ${opp.price_anomaly_pct.toFixed(1)}% with only $${opp.liquidity_usd} liquidity and ${opp.counterparty_count} counterparty(ies). Classic honey-pot signature.`
    );
  }

  // Signal 2: opportunity is brand new (< 60s old) and matches buy pattern
  if (opp.age_ms < 60_000 && opp.price_anomaly_pct >= 15) {
    reasons.push(
      `Opportunity is ${Math.floor(opp.age_ms / 1000)}s old with ${opp.price_anomaly_pct.toFixed(1)}% anomaly — too new to trust.`
    );
  }

  // Signal 3: single counterparty providing all the liquidity
  if (opp.counterparty_count === 1 && opp.liquidity_usd < 50_000) {
    reasons.push(
      `Single-counterparty opportunity with $${opp.liquidity_usd} liquidity. Adversary can drain instantly after swarm entry.`
    );
  }

  const baited = reasons.length > 0;
  const shouldBlock = baited && isEnforcing("honey_pot_detector");

  if (baited && rateLimitedEvent("honey_pot_detector")) {
    g.stats.baits_detected = (g.stats.baits_detected as number) + 1;
    if (shouldBlock) g.stats.baits_blocked = (g.stats.baits_blocked as number) + 1;
    pushEvent({
      guardrail: "honey_pot_detector",
      category: "security",
      severity: "critical",
      description: `Opportunity ${opp.id} flagged as potential honey-pot: ${reasons.length} signal(s).`,
      evidence: { opportunity: opp, reasons },
      recommendation:
        "Do not execute. If the swarm's buy pattern is predictable (e.g. always buy under price X), the adversary is exploiting that predictability. Add entropy to the buy criteria or require manual confirmation for high-anomaly opportunities.",
      blocked: shouldBlock,
    });
  }

  return { baited: shouldBlock, reasons };
}

/**
 * Scrub credentials / PII from a log line or agent debug output.
 * Returns the redacted string.
 */
export function scrubCredentials(input: string): string {
  const g = state.guardrails.credential_leak_scrubber;
  if (!g.enabled) return input;

  let output = input;
  let redactedCount = 0;

  for (const { regex, type } of CREDENTIAL_PATTERNS) {
    output = output.replace(regex, () => {
      redactedCount += 1;
      return `[REDACTED:${type}]`;
    });
  }

  g.stats.log_lines_scanned = (g.stats.log_lines_scanned as number) + 1;
  g.stats.secrets_redacted = (g.stats.secrets_redacted as number) + redactedCount;

  if (redactedCount > 0 && rateLimitedEvent("credential_leak_scrubber")) {
    pushEvent({
      guardrail: "credential_leak_scrubber",
      category: "security",
      severity: "critical",
      description: `${redactedCount} credential(s)/PII pattern(s) redacted from agent output.`,
      evidence: { count: redactedCount, sample_types: Array.from(new Set(CREDENTIAL_PATTERNS.map((p) => p.type))) },
      recommendation:
        "Audit the originating agent. If credentials appeared in its output, the agent has access it should not have. Revoke and rotate the exposed credentials immediately.",
      blocked: true,
    });
  }

  return output;
}

// ─── 2. LEGAL / COMPLIANCE GUARDRAILS ───────────────────────────────────

/**
 * Check whether a platform API call would exceed the platform's ToS rate limit.
 *
 * Returns true if the call is ALLOWED, false if blocked.
 */
export function checkTosRateLimit(platform: string, action: string): {
  allowed: boolean;
  remaining: number;
  reset_ms: number;
} {
  const g = state.guardrails.tos_rate_limit_enforcer;
  if (!g.enabled) return { allowed: true, remaining: Infinity, reset_ms: 0 };

  const key = `${platform}:${action}`;
  const limit = PLATFORM_RATE_LIMITS[platform.toLowerCase()];
  if (!limit) {
    // Unknown platform — allow but flag for review
    if (rateLimitedEvent("tos_rate_limit_enforcer")) {
      pushEvent({
        guardrail: "tos_rate_limit_enforcer",
        category: "legal",
        severity: "info",
        description: `Platform "${platform}" has no hardcoded rate limit. Defaulting to allow.`,
        evidence: { platform, action },
        recommendation: "Add an entry to PLATFORM_RATE_LIMITS before relying on this platform.",
        blocked: false,
      });
    }
    return { allowed: true, remaining: Infinity, reset_ms: 0 };
  }

  const now = Date.now();
  let counter = internal.platformRateCounters.get(key);
  if (!counter || now - counter.window_start > RATE_WINDOW_MS) {
    counter = { count: 0, window_start: now };
    internal.platformRateCounters.set(key, counter);
  }

  const wouldBe = counter.count + 1;
  if (wouldBe > limit.calls_per_min) {
    g.stats.calls_blocked = (g.stats.calls_blocked as number) + 1;
    if (rateLimitedEvent("tos_rate_limit_enforcer")) {
      pushEvent({
        guardrail: "tos_rate_limit_enforcer",
        category: "legal",
        severity: "warning",
        description: `Platform "${platform}" ${action} call blocked: would exceed ToS rate limit of ${limit.calls_per_min}/min.`,
        evidence: { platform, action, current: counter.count, limit: limit.calls_per_min, tos_url: limit.tos_url },
        recommendation: "Back off. Persistent violations trigger IP bans and legal cease-and-desist letters.",
        blocked: true,
      });
    }
    const resetMs = RATE_WINDOW_MS - (now - counter.window_start);
    return { allowed: false, remaining: 0, reset_ms: resetMs };
  }

  counter.count = wouldBe;
  g.stats.calls_allowed = (g.stats.calls_allowed as number) + 1;
  return { allowed: true, remaining: limit.calls_per_min - wouldBe, reset_ms: 0 };
}

/**
 * Check generated output against the IP/copyright blocklist.
 * Returns true if the output is CLEAR, false if blocked.
 */
export function checkIpCopyright(output: string): {
  clear: boolean;
  matched: Array<{ label: string; snippet: string }>;
} {
  const g = state.guardrails.ip_copyright_filter;
  if (!g.enabled) return { clear: true, matched: [] };

  const matched: Array<{ label: string; snippet: string }> = [];
  for (const { regex, label } of IP_BLOCKLIST) {
    const m = output.match(regex);
    if (m) {
      matched.push({ label, snippet: m[0].slice(0, 100) });
    }
  }

  g.stats.outputs_scanned = (g.stats.outputs_scanned as number) + 1;
  const clear = matched.length === 0 || !isEnforcing("ip_copyright_filter");

  if (matched.length > 0) {
    g.stats.outputs_blocked = (g.stats.outputs_blocked as number) + (clear ? 0 : 1);
    if (rateLimitedEvent("ip_copyright_filter")) {
      pushEvent({
        guardrail: "ip_copyright_filter",
        category: "legal",
        severity: clear ? "warning" : "critical",
        description: `Generated output matched ${matched.length} known copyrighted / license-conflicting pattern(s).`,
        evidence: { matched },
        recommendation:
          "Do not commercially deploy this output. Either rewrite the offending passages, attribute the source, or select a different generation strategy.",
        blocked: !clear,
      });
    }
  }

  return { clear, matched };
}

/**
 * Classify a transaction for tax purposes and update aggregate liability.
 */
export function classifyTransaction(args: {
  amount_cents: number;
  counterparty_country?: string;
  payment_rail?: string;
  transaction_id: string;
}): {
  jurisdiction: "us" | "eu" | "uk" | "ma" | "other";
  estimated_tax_cents: number;
} {
  const g = state.guardrails.tax_jurisdiction_classifier;
  if (!g.enabled) return { jurisdiction: "other", estimated_tax_cents: 0 };

  const jurisdiction = classifyTaxJurisdiction(args.counterparty_country, args.payment_rail);
  const rate = TAX_RATE_BY_JURISDICTION[jurisdiction] || 0;
  const taxCents = Math.round(args.amount_cents * rate);

  const key = `${jurisdiction}_cents` as keyof typeof g.stats;
  g.stats[key] = ((g.stats[key] as number) || 0) + args.amount_cents;
  g.stats.unaudited_liability_cents =
    ((g.stats.unaudited_liability_cents as number) || 0) + taxCents;

  // Surface warning if unaudited liability exceeds $10,000
  if (
    (g.stats.unaudited_liability_cents as number) > 1_000_000 &&
    rateLimitedEvent("tax_jurisdiction_classifier")
  ) {
    pushEvent({
      guardrail: "tax_jurisdiction_classifier",
      category: "legal",
      severity: "critical",
      description: `Unaudited tax liability exceeds $${((g.stats.unaudited_liability_cents as number) / 100).toFixed(2)}.`,
      evidence: {
        unaudited_liability_cents: g.stats.unaudited_liability_cents,
        by_jurisdiction: {
          us: g.stats.us_cents,
          eu: g.stats.eu_cents,
          uk: g.stats.uk_cents,
          ma: g.stats.ma_cents,
          other: g.stats.other_cents,
        },
      },
      recommendation:
        "Engage a tax professional. The swarm is generating thousands of micro-transactions across jurisdictions — manual reconciliation is no longer feasible. Either integrate a real tax engine (e.g. TaxJar, Avalara) or pause high-volume strategies.",
      blocked: false,
    });
  }

  return { jurisdiction, estimated_tax_cents: taxCents };
}

// ─── 3. INFRASTRUCTURE GUARDRAILS ───────────────────────────────────────

const BLACK_SWAN_FREEZE_MS = 5 * 60_000; // 5-min default freeze

/**
 * Report a critical dependency as unresponsive.
 * Triggers the Black-Swan freeze if the dependency has been down for >N seconds.
 */
export function reportDependencyUnresponsive(
  dependency: string,
  downSinceMs: number
): { frozen: boolean } {
  const g = state.guardrails.black_swan_breaker;
  if (!g.enabled) return { frozen: false };

  const downForMs = Date.now() - downSinceMs;
  if (downForMs < 30_000) return { frozen: false }; // grace period

  const alreadyFrozen = g.stats.freeze_active as boolean;
  if (!alreadyFrozen) {
    g.stats.freeze_active = true;
    g.stats.freezes_triggered = (g.stats.freezes_triggered as number) + 1;
    g.stats.last_freeze_reason = `${dependency} unresponsive for ${Math.floor(downForMs / 1000)}s`;
    pushEvent({
      guardrail: "black_swan_breaker",
      category: "infrastructure",
      severity: "critical",
      description: `Black-Swan freeze activated: dependency "${dependency}" has been unresponsive for ${Math.floor(downForMs / 1000)}s.`,
      evidence: { dependency, down_for_ms: downForMs },
      recommendation:
        "All panic-prone strategies (auto-buy, auto-sell, mass-pivot) are frozen. Do NOT let agents interpret the timeout as a market change. Wait for the dependency to recover or operator to manually clear the freeze.",
      blocked: true,
    });
  }

  return { frozen: true };
}

/**
 * Report that a dependency has recovered. Clears the freeze if active.
 */
export function reportDependencyRecovered(dependency: string): void {
  const g = state.guardrails.black_swan_breaker;
  if (!g.enabled) return;
  if (g.stats.freeze_active as boolean) {
    g.stats.freeze_active = false;
    pushEvent({
      guardrail: "black_swan_breaker",
      category: "infrastructure",
      severity: "info",
      description: `Black-Swan freeze cleared: dependency "${dependency}" recovered.`,
      evidence: { dependency },
      recommendation: "Resume normal operations. Run a model-drift probe before re-enabling autopilot.",
      blocked: false,
    });
  }
}

/**
 * Returns true if panic-prone strategies should be frozen right now.
 */
export function isBlackSwanFrozen(): boolean {
  const g = state.guardrails.black_swan_breaker;
  if (!g.enabled) return false;
  return g.stats.freeze_active as boolean;
}

/**
 * Manually clear the Black-Swan freeze (operator override).
 */
export function clearBlackSwanFreeze(): void {
  const g = state.guardrails.black_swan_breaker;
  g.stats.freeze_active = false;
  g.stats.last_freeze_reason = null;
}

const DEFAULT_LOCK_TTL_MS = 10_000; // 10s

/**
 * Try to acquire a per-resource exclusive lock.
 *
 * Returns true if acquired (or already held by the same holder).
 * Returns false if another agent holds the lock and it hasn't expired.
 *
 * Always pair with `releaseStateLock(resource, holder)` in a finally block.
 */
export function tryAcquireStateLock(
  resource: string,
  holder: string,
  ttlMs = DEFAULT_LOCK_TTL_MS
): boolean {
  const g = state.guardrails.distributed_state_mutex;
  if (!g.enabled) return true;

  const now = Date.now();
  const existing = internal.stateLocks.get(resource);

  if (existing) {
    if (existing.holder === holder) {
      // Reentrant — extend TTL
      existing.expires_at = now + ttlMs;
      existing.acquired_at = now;
      return true;
    }
    if (existing.expires_at > now) {
      // Contended
      g.stats.locks_contended = (g.stats.locks_contended as number) + 1;
      if (rateLimitedEvent("distributed_state_mutex")) {
        pushEvent({
          guardrail: "distributed_state_mutex",
          category: "infrastructure",
          severity: "warning",
          description: `State lock contention on resource "${resource}": held by ${existing.holder}, requested by ${holder}.`,
          evidence: { resource, holder, current_holder: existing.holder, expires_in_ms: existing.expires_at - now },
          recommendation:
            "Do NOT proceed with the write. Re-check the state after the lock expires, or coordinate with the holding agent. Ignoring this causes double-spend / duplicate orders.",
          blocked: true,
        });
      }
      return false;
    }
    // Expired — fall through and acquire
    g.stats.locks_expired = (g.stats.locks_expired as number) + 1;
  }

  internal.stateLocks.set(resource, { holder, expires_at: now + ttlMs, acquired_at: now });
  g.stats.locks_acquired = (g.stats.locks_acquired as number) + 1;
  return true;
}

/**
 * Release a previously-acquired state lock.
 */
export function releaseStateLock(resource: string, holder: string): void {
  const existing = internal.stateLocks.get(resource);
  if (existing && existing.holder === holder) {
    internal.stateLocks.delete(resource);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Exponential Backoff + Jitter — Recommended Action Plan §1
 * ────────────────────────────────────────────────────────────────────────
 *
 * When `tryAcquireStateLock` returns false (resource is contended),
 * the caller SHOULD NOT immediately retry in a tight loop — that
 * causes the "thundering herd" problem where N ticks all retry at
 * the same instant the lock expires, re-colliding.
 *
 * `acquireStateLockWithRetry` implements:
 *
 *   - Exponential backoff: delay = min(base * 2^attempt, maxDelay)
 *   - Full jitter: random uniform in [0, delay] — spreads retries
 *     across the backoff window so colliding ticks desynchronize.
 *   - Bounded attempts: gives up after `maxAttempts` and surfaces
 *     a stale-lock warning so the operator can intervene.
 *   - TTL-aware: each successful acquire stamps the holder's
 *     expiry; the retry loop re-checks on every attempt so an
 *     expiry mid-backoff is observed immediately.
 *
 * Default schedule (base=50ms, max=2000ms, attempts=8):
 *   attempt 0: try immediately
 *   attempt 1: sleep 0–50ms     (jittered)
 *   attempt 2: sleep 0–100ms
 *   attempt 3: sleep 0–200ms
 *   attempt 4: sleep 0–400ms
 *   attempt 5: sleep 0–800ms
 *   attempt 6: sleep 0–1600ms
 *   attempt 7: sleep 0–2000ms
 *   total worst-case wait ≈ 5.1s before giving up
 *
 * For a tick that fires every 12s, this gives ample room for a
 * stuck predecessor to either complete or hit its TTL (10–30s)
 * without piling up contention.
 */
export interface LockRetryOptions {
  /** Lock TTL in ms. Default 10_000. */
  ttlMs?: number;
  /** Base backoff delay in ms. Default 50. */
  baseDelayMs?: number;
  /** Cap on per-attempt backoff in ms. Default 2_000. */
  maxDelayMs?: number;
  /** Max acquire attempts (including the first immediate try). Default 8. */
  maxAttempts?: number;
  /**
   * Async sleep function — defaults to `() => new Promise(r => setTimeout(r, ms))`.
   * Overridable for testing.
   */
  sleeper?: (ms: number) => Promise<void>;
}

export interface LockRetryResult {
  acquired: boolean;
  holder: string;
  resource: string;
  attempts: number;
  /** Total ms spent sleeping across all retries. */
  waited_ms: number;
  /** The holder that was blocking us, if we gave up. */
  blocked_by?: string;
  /** Whether the blocking lock was stale (expired TTL) when we gave up. */
  blocked_lock_stale?: boolean;
}

/**
 * Sleep helper — exposed so tests can swap it.
 */
const defaultSleeper = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try to acquire `resource` for `holder`, retrying with full-jitter
 * exponential backoff on contention. Resolves with a LockRetryResult.
 *
 * The caller MUST call `releaseStateLock(resource, holder)` in a
 * finally block once acquired.
 */
export async function acquireStateLockWithRetry(
  resource: string,
  holder: string,
  opts: LockRetryOptions = {}
): Promise<LockRetryResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const baseDelayMs = opts.baseDelayMs ?? 50;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;
  const maxAttempts = opts.maxAttempts ?? 8;
  const sleeper = opts.sleeper ?? defaultSleeper;

  let attempts = 0;
  let waitedMs = 0;
  let lastBlockedBy: string | undefined;
  let lastBlockedStale = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;
    const ok = tryAcquireStateLock(resource, holder, ttlMs);
    if (ok) {
      return {
        acquired: true,
        holder,
        resource,
        attempts,
        waited_ms: waitedMs,
      };
    }

    // Contended — inspect the blocker for telemetry.
    const existing = internal.stateLocks.get(resource);
    lastBlockedBy = existing?.holder;
    lastBlockedStale = existing ? existing.expires_at <= Date.now() : true;

    // Last attempt — don't sleep, just give up.
    if (attempt === maxAttempts - 1) break;

    // Full-jitter exponential backoff.
    const rawDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const jittered = Math.random() * rawDelay;
    const sleepMs = Math.round(jittered);
    await sleeper(sleepMs);
    waitedMs += sleepMs;
  }

  return {
    acquired: false,
    holder,
    resource,
    attempts,
    waited_ms: waitedMs,
    blocked_by: lastBlockedBy,
    blocked_lock_stale: lastBlockedStale,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Leaked / Stalled Lock Recovery — Recommended Action Plan §2
 * ────────────────────────────────────────────────────────────────────────
 *
 * `tryAcquireStateLock` already enforces a TTL — expired locks are
 * auto-reclaimed on the next acquire attempt. But "leaked" locks
 * (a holder that crashed without calling releaseStateLock) will
 * sit in `internal.stateLocks` until the next acquire attempt
 * happens against the same resource. If no other agent ever
 * touches that resource again, the leaked entry is never cleaned.
 *
 * The helpers below let the operator inspect and force-clean
 * stale locks through the `/api/orchestrator/locks` endpoint.
 */

export interface ActiveLockSnapshot {
  resource: string;
  holder: string;
  acquired_at: number;
  expires_at: number;
  ttl_ms: number;
  age_ms: number;
  remaining_ms: number;
  stale: boolean;
}

/**
 * Returns a snapshot of every lock currently in `internal.stateLocks`,
 * including stale (TTL-expired but not yet reclaimed) entries.
 *
 * Used by the `/api/orchestrator/locks` GET endpoint and by
 * `audit-locks.mjs` to surface leaked locks.
 */
export function listActiveLocks(): ActiveLockSnapshot[] {
  const now = Date.now();
  const out: ActiveLockSnapshot[] = [];
  for (const [resource, entry] of internal.stateLocks.entries()) {
    const ttlMs = Math.max(0, entry.expires_at - (entry.acquired_at ?? entry.expires_at - DEFAULT_LOCK_TTL_MS));
    out.push({
      resource,
      holder: entry.holder,
      acquired_at: entry.acquired_at ?? (entry.expires_at - ttlMs),
      expires_at: entry.expires_at,
      ttl_ms: ttlMs,
      age_ms: now - (entry.acquired_at ?? (entry.expires_at - ttlMs)),
      remaining_ms: entry.expires_at - now,
      stale: entry.expires_at <= now,
    });
  }
  return out.sort((a, b) => a.expires_at - b.expires_at);
}

/**
 * Force-release a lock, regardless of holder.
 *
 * This is the recovery path for leaked locks where the original
 * holder is known to have died (e.g., a tick that timed out and
 * was killed by the upstream proxy). The caller MUST record an
 * audit event — we push one here so the action is traceable.
 *
 * Returns true if a lock was removed, false if no lock existed
 * for `resource`.
 */
export function forceReleaseLock(
  resource: string,
  reason: string
): boolean {
  const existing = internal.stateLocks.get(resource);
  if (!existing) return false;
  internal.stateLocks.delete(resource);

  const g = state.guardrails.distributed_state_mutex;
  g.stats.locks_expired = (g.stats.locks_expired as number) + 1;
  if (rateLimitedEvent("distributed_state_mutex")) {
    pushEvent({
      guardrail: "distributed_state_mutex",
      category: "infrastructure",
      severity: "warning",
      description: `Lock on "${resource}" force-released: ${reason}`,
      evidence: {
        resource,
        reason,
        previous_holder: existing.holder,
        previous_expiry: new Date(existing.expires_at).toISOString(),
        previous_remaining_ms: existing.expires_at - Date.now(),
      },
      recommendation:
        "Investigate why the original holder did not release the lock. " +
        "If the holder is a tick that timed out, consider lowering the tick TTL " +
        "or moving long-running work out of the tick path.",
      blocked: false,
    });
  }
  return true;
}

/**
 * Reclaim every stale (TTL-expired) lock in a single sweep.
 *
 * Returns the count of locks reclaimed. Safe to call on every tick
 * — cheap O(N) over the (typically small) lock map.
 */
export function reclaimStaleLocks(): number {
  const now = Date.now();
  let count = 0;
  for (const [resource, entry] of internal.stateLocks.entries()) {
    if (entry.expires_at <= now) {
      internal.stateLocks.delete(resource);
      count++;
    }
  }
  if (count > 0) {
    const g = state.guardrails.distributed_state_mutex;
    g.stats.locks_expired = (g.stats.locks_expired as number) + count;
  }
  return count;
}

/**
 * Run the model-drift probe.
 *
 * In production this would call the live LLM with the frozen prompts and
 * compare outputs. Here we accept a `probeOutputs` array (one per suite
 * entry) and compare against expected signatures.
 *
 * Returns true if drift detected.
 */
export function runModelDriftProbe(probeOutputs: string[]): {
  drift_detected: boolean;
  mismatches: Array<{ id: string; expected: string; got: string }>;
} {
  const g = state.guardrails.model_drift_probe;
  if (!g.enabled) return { drift_detected: false, mismatches: [] };

  const mismatches: Array<{ id: string; expected: string; got: string }> = [];
  for (let i = 0; i < internal.driftProbeSuite.length; i++) {
    const entry = internal.driftProbeSuite[i];
    const got = (probeOutputs[i] || "").trim();
    if (got !== entry.expected_signature) {
      mismatches.push({ id: entry.id, expected: entry.expected_signature, got });
    }
  }

  const driftDetected = mismatches.length > 0;
  g.stats.last_probe_at = new Date().toISOString();
  g.stats.last_signature = probeOutputs.join("|").slice(0, 64);
  g.stats.drift_detected = driftDetected;
  g.stats.probes_run = (g.stats.probes_run as number) + 1;

  if (driftDetected && rateLimitedEvent("model_drift_probe")) {
    pushEvent({
      guardrail: "model_drift_probe",
      category: "infrastructure",
      severity: "critical",
      description: `Model drift detected: ${mismatches.length}/${internal.driftProbeSuite.length} baseline(s) produced unexpected output.`,
      evidence: { mismatches },
      recommendation:
        "The underlying LLM provider likely pushed a silent backend update. Re-validate the swarm's prompt suite end-to-end before resuming autopilot. Pin to a specific model version if possible.",
      blocked: false,
    });
  }

  return { drift_detected: driftDetected, mismatches };
}

// ─── 4. ECONOMIC GUARDRAILS ─────────────────────────────────────────────

const TOKEN_COST_PER_1K = 0.005; // $0.005 per 1K tokens, conservative blend
const TOKEN_MARGIN_THRESHOLD_CENTS_PER_DOLLAR = 50; // halt if token cost > 50% of revenue

/**
 * Record per-strategy token consumption and revenue.
 *
 * Called by the orchestrator after each task completes. If the ratio of
 * token cost to revenue exceeds the threshold, the strategy is paused.
 */
export function recordStrategyEconomics(
  strategyId: string,
  tokensConsumed: number,
  revenueCents: number
): {
  paused: boolean;
  ratio_cents_per_dollar: number;
} {
  const g = state.guardrails.token_margin_inversion;
  if (!g.enabled) return { paused: false, ratio_cents_per_dollar: 0 };

  let acct = internal.strategyAccounting.get(strategyId);
  if (!acct) {
    acct = { tokens: 0, revenue_cents: 0 };
    internal.strategyAccounting.set(strategyId, acct);
  }
  acct.tokens += tokensConsumed;
  acct.revenue_cents += revenueCents;

  if (acct.revenue_cents <= 0) return { paused: false, ratio_cents_per_dollar: 0 };

  const tokenCostUsd = (acct.tokens / 1000) * TOKEN_COST_PER_1K;
  const tokenCostCents = tokenCostUsd * 100;
  const revenueDollars = acct.revenue_cents / 100;
  const ratioCentsPerDollar = revenueDollars > 0 ? tokenCostCents / revenueDollars : Infinity;

  // Track worst ratio seen
  if (ratioCentsPerDollar > (g.stats.worst_ratio_cents_per_dollar as number)) {
    g.stats.worst_ratio_cents_per_dollar = ratioCentsPerDollar;
  }

  const threshold = (g.stats.threshold_cents_per_dollar as number) || TOKEN_MARGIN_THRESHOLD_CENTS_PER_DOLLAR;
  if (ratioCentsPerDollar > threshold) {
    const paused = isEnforcing("token_margin_inversion");
    g.stats.strategies_paused = (g.stats.strategies_paused as number) + (paused ? 1 : 0);
    if (rateLimitedEvent("token_margin_inversion")) {
      pushEvent({
        guardrail: "token_margin_inversion",
        category: "economic",
        severity: paused ? "critical" : "warning",
        description: `Strategy "${strategyId}" token-margin inverted: ${ratioCentsPerDollar.toFixed(1)} cents of token cost per $1 of revenue (threshold: ${threshold}).`,
        evidence: {
          strategy: strategyId,
          tokens: acct.tokens,
          revenue_cents: acct.revenue_cents,
          token_cost_cents: tokenCostCents,
          ratio_cents_per_dollar: ratioCentsPerDollar,
          threshold,
        },
        recommendation:
          "Pause the strategy. Profitable-at-any-volume thinking is wrong — the math has to work per unit. Either reduce token consumption (cheaper model, shorter prompts, caching) or move to a higher-revenue opportunity.",
        blocked: paused,
      });
    }
    return { paused, ratio_cents_per_dollar: ratioCentsPerDollar };
  }

  return { paused: false, ratio_cents_per_dollar: ratioCentsPerDollar };
}

/**
 * Check whether a strategy is currently paused due to token-margin inversion.
 */
export function isStrategyPaused(strategyId: string): boolean {
  const g = state.guardrails.token_margin_inversion;
  if (!g.enabled || !isEnforcing("token_margin_inversion")) return false;
  const acct = internal.strategyAccounting.get(strategyId);
  if (!acct || acct.revenue_cents <= 0) return false;
  const tokenCostCents = ((acct.tokens / 1000) * TOKEN_COST_PER_1K) * 100;
  const revenueDollars = acct.revenue_cents / 100;
  const ratio = tokenCostCents / revenueDollars;
  const threshold = (g.stats.threshold_cents_per_dollar as number) || TOKEN_MARGIN_THRESHOLD_CENTS_PER_DOLLAR;
  return ratio > threshold;
}

/**
 * Record gross volume attributed to an external platform.
 * Used by the platform-dependency lock-in detector.
 */
export function recordPlatformVolume(platform: string, amountCents: number): void {
  const g = state.guardrails.platform_dependency_lockin;
  if (!g.enabled) return;

  const current = internal.platformVolume.get(platform) || 0;
  internal.platformVolume.set(platform, current + amountCents);

  // Recompute shares
  let total = 0;
  for (const v of internal.platformVolume.values()) total += v;
  if (total <= 0) return;

  let dominantPlatform: string | null = null;
  let dominantPct = 0;
  for (const [p, v] of internal.platformVolume.entries()) {
    const pct = (v / total) * 100;
    if (pct > dominantPct) {
      dominantPct = pct;
      dominantPlatform = p;
    }
  }
  g.stats.dominant_platform = dominantPlatform;
  g.stats.dominant_platform_pct = dominantPct;

  const threshold = (g.stats.threshold_pct as number) || 60;
  if (dominantPct > threshold && dominantPlatform && rateLimitedEvent("platform_dependency_lockin")) {
    pushEvent({
      guardrail: "platform_dependency_lockin",
      category: "economic",
      severity: dominantPct >= 85 ? "critical" : "warning",
      description: `Platform "${dominantPlatform}" accounts for ${dominantPct.toFixed(1)}% of gross volume (threshold: ${threshold}%).`,
      evidence: {
        dominant_platform: dominantPlatform,
        dominant_pct: dominantPct,
        all_platforms: Object.fromEntries(internal.platformVolume),
      },
      recommendation:
        "Diversify before this platform changes its terms. A single policy change, fee hike, or algorithmic adjustment by this platform would cripple the swarm's entire business model.",
      blocked: false,
    });
  }
}

// ─── Orchestrator integration ───────────────────────────────────────────

/**
 * Called by orchestrator.tick() at the START.
 * Returns whether the tick may proceed.
 *
 * Blocked if:
 *   - Black-Swan freeze is active (panic-prone strategies frozen)
 *   - Any CRITICAL-mode guardrail has halted the swarm
 */
export function preGuardrailCheck(): { proceed: boolean; reason?: string } {
  if (isBlackSwanFrozen()) {
    return {
      proceed: false,
      reason: `black_swan_breaker: ${state.guardrails.black_swan_breaker.stats.last_freeze_reason || "freeze active"}`,
    };
  }
  return { proceed: true };
}

/**
 * Called by orchestrator.tick() at the END.
 * Currently a no-op — kept for future use (e.g. periodic drift probe).
 */
export function postGuardrailTick(_report: unknown): void {
  state.last_evaluated_at = new Date().toISOString();
  state.generated_at = new Date().toISOString();
}

// ─── Manual controls ────────────────────────────────────────────────────

export function setGuardrailEnabled(id: GuardrailId, enabled: boolean): void {
  const g = state.guardrails[id];
  if (g) g.enabled = enabled;
}

export function setGuardrailMode(id: GuardrailId, mode: GuardrailMode): void {
  const g = state.guardrails[id];
  if (g) g.mode = mode;
}

export function setGlobalMode(mode: GuardrailMode): void {
  state.mode = mode;
}

export function clearGuardrailEvents(): void {
  state.events = [];
  internal.lastEventAt.clear();
}

/**
 * Clear per-strategy accounting + per-platform volume counters.
 * Useful when starting a new accounting period.
 */
export function clearEconomicCounters(): void {
  internal.strategyAccounting.clear();
  internal.platformVolume.clear();
  const t = state.guardrails.token_margin_inversion;
  const p = state.guardrails.platform_dependency_lockin;
  t.stats.worst_ratio_cents_per_dollar = 0;
  t.stats.strategies_paused = 0;
  p.stats.dominant_platform = null;
  p.stats.dominant_platform_pct = 0;
}

// ─── Snapshot ───────────────────────────────────────────────────────────

export function getGuardrailState(): GuardrailState {
  return JSON.parse(JSON.stringify(state));
}

export function getGuardrailEvents(limit = 50): GuardrailEvent[] {
  return state.events.slice(0, limit);
}

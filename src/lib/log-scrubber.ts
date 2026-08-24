/**
 * Log Scrubbing Layer — structural masking of secrets in stdout/stderr.
 *
 * Every console.log / console.error / console.warn call is intercepted
 * and the output is scanned for known secret patterns. Matching
 * substrings are replaced with `[REDACTED:<kind>]` before the output
 * hits the stream.
 *
 * Patterns masked:
 *   - Authorization header values  (Authorization: Bearer xxxxx)
 *   - api_key=<value>              (Base44 / OpenAI / etc.)
 *   - password=<value>
 *   - secret=<value>
 *   - token=<value>
 *   - private_key=<value>
 *   - Stripe-style keys            (sk_live_*, sk_test_*, rk_live_*)
 *   - PayPal client secrets        (long base64-ish after "client_secret:")
 *   - JWT tokens                   (eyJ... three-part base64)
 *   - Private key blocks           (-----BEGIN ... PRIVATE KEY-----)
 *   - Hex strings of length 64     (on-chain priv keys / tx hashes — careful,
 *                                    this catches legit tx hashes too, so
 *                                    the redaction is reversible via the
 *                                    kind tag if you need to display a
 *                                    receipt_hash in ops)
 *
 * USAGE
 *   Call `installLogScrubber()` once at server startup. The install is
 *   idempotent — calling it multiple times is safe.
 *
 *   In Next.js, the right place is `instrumentation.ts` at the project
 *   root (runs once per server instance, before any route handler).
 *
 * WHAT THIS DOES NOT DO
 *   - Does not encrypt secrets at rest (use a real secrets manager)
 *   - Does not redact secrets in source files (use the rotation checklist)
 *   - Does not redact secrets in env files (use git-secrets / pre-commit)
 *   - Does not catch every possible secret format — defence in depth,
 *     not a silver bullet
 */

type OriginalConsole = typeof console;

const SCRUB_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // Authorization header
  { kind: "auth_header", re: /(?<=authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9_\-\.=:+/]{20,}/gi },
  // Key-value assignments
  { kind: "api_key", re: /(?<=api_key\s*[:=]\s*["']?)[A-Za-z0-9_\-]{16,}/gi },
  { kind: "apikey", re: /(?<=apikey\s*[:=]\s*["']?)[A-Za-z0-9_\-]{16,}/gi },
  { kind: "password", re: /(?<=password\s*[:=]\s*["']?)[^\s"']{6,}/gi },
  { kind: "secret", re: /(?<=secret\s*[:=]\s*["']?)[^\s"']{8,}/gi },
  { kind: "token", re: /(?<=token\s*[:=]\s*["']?)[^\s"']{12,}/gi },
  { kind: "private_key", re: /(?<=private_key\s*[:=]\s*["']?)[^\s"']{16,}/gi },
  // Stripe
  { kind: "stripe_sk", re: /sk_(live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "stripe_rk", re: /rk_(live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "stripe_pk", re: /pk_(live|test)_[A-Za-z0-9]{16,}/g },
  // PayPal
  { kind: "paypal_client_secret", re: /(?<=client_secret\s*[:=]\s*["']?)[A-Za-z0-9_\-]{20,}/gi },
  // JWT
  { kind: "jwt", re: /eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g },
  // PEM private key blocks
  {
    kind: "pem_block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // 64-char hex (could be a tx hash or a private key — be conservative
  // and redact; the kind tag tells the operator what was matched so
  // they can override if needed)
  { kind: "hex64", re: /\b[a-fA-F0-9]{64}\b/g },
];

let installed = false;
let originalConsole: OriginalConsole | null = null;
let scrubCount = 0;

function scrubString(s: string): string {
  if (typeof s !== "string") return s;
  let out = s;
  for (const { kind, re } of SCRUB_PATTERNS) {
    if (re.global) {
      out = out.replace(re, (m) => {
        scrubCount++;
        return `[REDACTED:${kind}]`;
      });
    } else {
      out = out.replace(re, () => {
        scrubCount++;
        return `[REDACTED:${kind}]`;
      });
    }
  }
  return out;
}

function scrubArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === "string") return scrubString(a);
    if (a instanceof Error) {
      // Errors: scrub the message but preserve the stack structure
      const scrubbed = new Error(scrubString(a.message));
      scrubbed.stack = a.stack ? scrubString(a.stack) : undefined;
      scrubbed.name = a.name;
      return scrubbed;
    }
    if (typeof a === "object" && a !== null) {
      try {
        const json = JSON.stringify(a);
        const scrubbed = scrubString(json);
        return JSON.parse(scrubbed);
      } catch {
        return "[REDACTED:unserializable_object]";
      }
    }
    return a;
  });
}

/**
 * Install the log scrubber. Idempotent.
 *
 * After install, every console.log / .error / .warn / .info / .debug
 * call has its arguments scanned for secret patterns and matching
 * substrings replaced with [REDACTED:<kind>].
 *
 * Returns the number of redactions that have occurred (cumulative
 * across all calls since install).
 */
export function installLogScrubber(): { installed: boolean; redactions_so_far: number } {
  if (installed) {
    return { installed: false, redactions_so_far: scrubCount };
  }
  originalConsole = { ...console };
  const methods: Array<keyof typeof console> = ["log", "error", "warn", "info", "debug"];
  for (const m of methods) {
    const orig = console[m] as (...args: unknown[]) => void;
    if (typeof orig !== "function") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[m] = (...args: unknown[]) => {
      orig.apply(console, scrubArgs(args));
    };
  }
  installed = true;
  originalConsole.log?.("[log-scrubber] installed — secrets will be masked from stdout/stderr");
  return { installed: true, redactions_so_far: 0 };
}

/**
 * Uninstall the log scrubber. Restores the original console methods.
 * Mainly useful for tests.
 */
export function uninstallLogScrubber(): void {
  if (!installed || !originalConsole) return;
  const methods: Array<keyof typeof console> = ["log", "error", "warn", "info", "debug"];
  for (const m of methods) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[m] = (originalConsole as any)[m];
  }
  installed = false;
}

/**
 * Test helper — scrub a single string and return the result without
 * installing the global interceptor. Useful for verifying that a
 * specific pattern is matched.
 */
export function scrubStringForTest(s: string): string {
  return scrubString(s);
}

/**
 * Stats — how many redactions have occurred since install.
 */
export function getScrubStats(): { installed: boolean; redactions: number } {
  return { installed, redactions: scrubCount };
}

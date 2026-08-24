// Quick verification that the log scrubber masks known secret patterns.
import { scrubStringForTest, installLogScrubber, getScrubStats } from "../src/lib/log-scrubber.ts";

const cases = [
  ["api_key assignment", 'api_key="e599b5b131574c1bae885fc013620739"'],
  ["authorization header", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456"],
  ["stripe sk_live", "Found key sk_live_AbCdEf1234567890 in logs"],
  ["jwt token", "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature1234567890abcdef"],
  ["password", "password=supersecret123"],
  ["pem block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"],
  ["hex64 (tx hash)", "tx hash: a1b2c3d4e5f60718293a4b5c6d7e8f9001020304050607080910111213141516"],
  ["plain text (no secrets)", "Hello world — nothing to redact here"],
];

let pass = 0;
let fail = 0;
for (const [name, input] of cases) {
  const out = scrubStringForTest(input);
  const redacted = out.includes("[REDACTED:");
  const expected = name !== "plain text (no secrets)";
  const ok = redacted === expected;
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
    console.log(`      in:  ${input.slice(0, 80)}${input.length > 80 ? "..." : ""}`);
    console.log(`      out: ${out.slice(0, 80)}${out.length > 80 ? "..." : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
    console.log(`      in:  ${input}`);
    console.log(`      out: ${out}`);
  }
}

// Also test the installed scrubber intercepts console.log
installLogScrubber();
const before = getScrubStats().redactions;
console.log("test api_key=abcdefghijklmnop");
const after = getScrubStats().redactions;
if (after > before) {
  console.log(`PASS  installed scrubber caught a secret (redactions: ${before} → ${after})`);
  pass++;
} else {
  console.log(`FAIL  installed scrubber did not catch a secret (redactions: ${before} → ${after})`);
  fail++;
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

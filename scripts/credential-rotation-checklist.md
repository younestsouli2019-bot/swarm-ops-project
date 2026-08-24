# Credential Hygiene & Emergency Rotation Matrix

- **Generated**: 2026-08-16
- **Status**: Living document — update whenever a credential is rotated or a new secret is introduced
- **Scope**: All credentials, identifiers, and secrets that touch the ChariBaaS codebase

## 1. Source Code Audit Findings (2026-08-16)

A source-wide grep for inline secret patterns (`api_key|apikey|secret|password|token|private_key\s*[:=]\s*["']...{8,}["']`) found:

| File | Finding | Action |
|---|---|---|
| `src/lib/base44.ts:14` | `BASE44_API_KEY = "e599b5b131574c1bae885fc013620739"` | **PATCHED** — now reads from `process.env.BASE44_API_KEY` |
| `scripts/audit-and-quarantine.mjs:44` | Same key inlined | **PATCHED** — now reads from env |
| `scripts/audit-final-consolidation.mjs:9` | Same key inlined | **PATCHED** — now reads from env |
| `scripts/verify-payout-integrity.mjs:61` | Same key inlined | **PATCHED** — now reads from env |
| `scripts/test_settlement_ledger.mjs:182` | `prepare_token: "fake_token"` | Safe — test fixture, not a real secret |

The Base44 key was committed to source history. Treat it as **compromised**.

## 2. Critical Identifier Rotation Checklist

| Target Credential / ID | Risk Profile | Target Infrastructure Pattern | Remediation Timeline | Status |
|---|---|---|---|---|
| **Base44 API Key** (`e599b5b1...`) | CRITICAL | Rotate at https://agent-swarm-efe0bd7e.base44.app → Settings → API Keys. New value goes into `.env` (dev) or AWS Secrets Manager / Doppler Vault (prod). Old key revoked. | Immediate (< 2 hours) | ⏳ PENDING — code patched to read from env, but old key still active. Operator must rotate. |
| **Live PSP API Keys** (Stripe / Wise / Currencycloud) | CRITICAL | AWS Secrets Manager / Doppler Vault injection via IAM role. Never in `.env`. Code reads via `process.env.STRIPE_SECRET_KEY` only. | Immediate (< 2 hours) when PSP is integrated | N/A — no PSP integrated yet |
| **Database Master Credentials** (`DATABASE_URL`) | HIGH | For SQLite dev: file path only (no creds). For prod Postgres: IAM DB Authentication (short-lived tokens) via RDS IAM. No long-lived password. | Immediate (< 4 hours) when prod DB is provisioned | OK for dev — prod DB not yet provisioned |
| **Bank Statement SFTP / SSH keys** | MEDIUM | AWS Systems Manager Parameter Store encrypted via KMS. SSH key never written to disk. Code reads via `process.env.BANK_SFTP_KEY_PATH` pointing to a tmpfs mount. | Next scheduled deploy | N/A — no SFTP integration yet |
| **Webhook Inbound Salts** (for PSP signature verification) | MEDIUM | Environment injection with runtime verification logic. Code refuses to start if webhook salt is missing AND a PSP rail adapter is registered. | Next scheduled deploy | N/A — no PSP webhooks yet |
| **JWT Session Secret** (for `/api/payouts/authorize` human_session flow) | HIGH | Random 32-byte secret generated at deploy time. Stored in secrets manager. Rotated every 90 days. | Before enabling human authorization | N/A — authorization endpoint not yet wired to real JWT verification |
| **Owner Bank Account Identifiers** (RIBs, IBANs, routing numbers, wallet addresses, Payoneer PRQ token) | CRITICAL | These are NOT credentials and do NOT belong in source code or env files. They belong in `PayoutRecipient` records in the database, accessible only via the payout state machine's rail adapter at submit time. | Already in DB (post-audit: 11 records, 1 quarantined) | ⚠️ EXPOSED — the full set was pasted into the chat history on 2026-08-16. Treat the Payoneer PRQ token (`325EF6267B78444D86BF8286069806BE`) and the Trust Wallet / Bybit addresses as compromised. **Rotate them at the respective providers.** |

## 3. Rotation Procedure (per credential)

### 3.1 Base44 API Key

1. Log into https://agent-swarm-efe0bd7e.base44.app
2. Settings → API Keys → "Generate new key"
3. Copy the new key value (you won't see it again)
4. Update `.env` locally: `BASE44_API_KEY=<new_value>`
5. Update the secrets manager in production (when deployed)
6. Revoke the old key in the Base44 dashboard
7. Verify: `curl -H "api_key: $BASE44_API_KEY" https://agent-swarm-efe0bd7e.base44.app/api/entities/Agent?limit=1` returns 200

### 3.2 Payoneer PRQ Token

1. Log into Payoneer
2. Settings → Payment Requests → Revoke existing token
3. Generate a new token
4. The new token goes into a `PayoutRecipient` record via the Base44 API — NOT into source or env
5. Update any pending `PayoutItem` records that referenced the old token

### 3.3 Crypto Wallet Addresses (Trust Wallet / Bybit)

1. Generate new wallet addresses in the respective wallet apps
2. Move any funds from the old addresses to the new ones (via the wallet app, NOT via this software)
3. Update `PayoutRecipient` records in Base44 with the new addresses
4. The old addresses should be considered watched forever — anyone who saw them in chat history can monitor them

### 3.4 Bank Account Details (Attijariwafa, Citibank, Barclays, Banking Circle, MUFG)

Bank account numbers, routing numbers, IBANs, and SWIFT codes are **not credentials** — they're identifying information that appears on every invoice and check. They cannot be "rotated" in the cryptographic sense. However:

1. **Monitor** the accounts for unauthorized access attempts (enable login alerts)
2. **Enable 2FA** on every e-banking portal if not already
3. **Notify the bank** that account identifiers may have been exposed in a communication channel — they may flag the account for additional verification on new payees
4. **Do not** close the accounts unless you see actual unauthorized transactions — closing accounts is disruptive and the identifiers alone don't permit withdrawals

## 4. Log Scrubbing Layer

A structural log masking layer is now installed via `src/lib/log-scrubber.ts` and loaded by `instrumentation.ts` at server startup. The scrubber intercepts every `console.log` / `.error` / `.warn` / `.info` / `.debug` call and replaces matching secret patterns with `[REDACTED:<kind>]` before the output hits stdout/stderr.

### Patterns Masked

| Kind | Pattern |
|---|---|
| `auth_header` | `Authorization: Bearer xxxxx` |
| `api_key` | `api_key=<16+ char value>` |
| `apikey` | `apikey=<16+ char value>` |
| `password` | `password=<6+ char value>` |
| `secret` | `secret=<8+ char value>` |
| `token` | `token=<12+ char value>` |
| `private_key` | `private_key=<16+ char value>` |
| `stripe_sk` | `sk_live_*` / `sk_test_*` |
| `stripe_rk` | `rk_live_*` / `rk_test_*` |
| `stripe_pk` | `pk_live_*` / `pk_test_*` |
| `paypal_client_secret` | `client_secret=<20+ char value>` |
| `jwt` | `eyJ...eyJ...<sig>` (three-part base64) |
| `pem_block` | `-----BEGIN ... PRIVATE KEY-----` |
| `hex64` | 64-char hex string (tx hashes, private keys) |

### What the Scrubber Does NOT Do

- Does not encrypt secrets at rest (use a real secrets manager)
- Does not redact secrets in source files (that's what this checklist is for)
- Does not redact secrets in env files (use `git-secrets` / pre-commit hooks)
- Does not catch every possible secret format — defence in depth, not a silver bullet

### Verifying the Scrubber

```bash
# Should print "[REDACTED:api_key]" instead of the actual key
node -e "process.env.BASE44_API_KEY='test123'; require('./src/lib/log-scrubber').installLogScrubber(); console.log('api_key=' + process.env.BASE44_API_KEY)"
```

## 5. .env File Hygiene

The current `.env` file contains:

```
DATABASE_URL=file:/home/z/my-project/db/custom.db
BASE44_API_KEY=e599b5b131574c1bae885fc013620739
```

Rules going forward:

1. **`.env` is for development only.** Production reads from a secrets manager.
2. **`.env` is in `.gitignore`.** Verify with `git check-ignore .env` (should print `.env`).
3. **`.env.example`** should exist with placeholder values, documenting what env vars are expected. (To be created.)
4. **Never** commit a real credential to source. Pre-commit hook (`git-secrets` or equivalent) should be installed to catch accidents.
5. **Rotate** any credential that was committed to source history, even if it was later removed — git history is forever.

## 6. Action Items for the Operator

- [ ] Rotate the Base44 API key at https://agent-swarm-efe0bd7e.base44.app → Settings → API Keys
- [ ] Update `.env` with the new key value
- [ ] Rotate the Payoneer PRQ token (exposed in chat)
- [ ] Generate new Trust Wallet and Bybit addresses, move funds via the wallet apps (not via this software), update `PayoutRecipient` records
- [ ] Enable 2FA on every e-banking portal (Attijariwafa, Citibank, Barclays, Banking Circle, MUFG)
- [ ] Notify each bank that account identifiers may have been exposed in a communication channel
- [ ] Install `git-secrets` pre-commit hook: `brew install git-secrets && git secrets --install`
- [ ] Create `.env.example` with placeholder values (next task for the agent)

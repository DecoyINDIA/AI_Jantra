# Jantra Threat Model

Status: initial version, 2026-11-18. Scope is the hosted API (`src/server`), the
Research pipeline, outbound webhooks, and the Cloudflare edge. The desktop app is
covered only where it shares server code. This is a design-level model plus a
targeted review, not a full penetration test.

## Assets

| Asset | Why it matters |
|---|---|
| Tenant runs, artifacts, audit logs | Confidential client strategy; cross-tenant leakage ends trust |
| Lead records (name, email, phone) | Personal data; regulatory exposure |
| API keys, admin token, provider keys, connector credentials | Full account takeover or spend |
| Model spend budget | Direct financial loss through abuse |
| Integrity of research citations | "Ground or abstain" is the product promise |
| Internal network reachable from the host | SSRF pivot target (cloud metadata, private services) |

## Trust boundaries

1. **Browser to edge.** Visitors are anonymous and untrusted. The edge holds the
   public-scope API key; browsers never see it.
2. **Edge to origin.** The origin trusts `X-Jantra-Client-IP` only on
   public-scope keys, which only the edge holds.
3. **Operator to origin.** Full-scope keys; tenant is derived server-side.
4. **Origin to the web (Research fetch, webhooks, ops delivery).** Every
   outbound URL is caller- or model-influenced.
5. **Fetched content to the model.** Pages are data, never instructions.
6. **Model output to artifacts.** Model claims are untrusted until verified
   deterministically.

## Threats and controls

| ID | Threat | Control | Residual risk |
|---|---|---|---|
| T1 | SSRF via webhook URL, Research source, redirect, or DNS rebinding | `safeFetch` resolves and re-checks every hop at connect time; `netGuard` blocklist; manual redirects; size and time caps | Low. IPv6 transition ranges (IPv4-compatible, 6to4, Teredo, local NAT64, site-local) added 2026-11-18 |
| T2 | Indirect prompt injection from fetched pages | NFKC normalization, invisible-character stripping, pattern redaction, random-id untrusted fence, deterministic quote verification against the sanitized text, human gate | Medium. Pattern matching cannot catch paraphrase or obfuscation such as leetspeak. The fence and the citation verifier are the real boundary |
| T3 | Cross-tenant access (IDOR) | `requestClientId` from identity; `assertProjectAccess` after each load; store keyed by `clientId` | Low. Covered by existing tenancy regressions |
| T4 | Visitor reads or hijacks another visitor's run | Public run creation issues a 256-bit `runToken` (only its SHA-256 is stored); public-scope reads, advances, interactions and lead linking require it, and a wrong token returns the same 404 as a missing run; public keys limited to an allowlist of routes and agents | Low. The token lives in page memory, so XSS on the embedding site could still read it |
| T5 | Budget exhaustion through the public widget | Edge per-IP limiter; Turnstile token required to create runs or leads when `TURNSTILE_SECRET_KEY` is set (fails closed, checks hostname); origin pre-auth and identity limiters; per-visitor and per-client daily spend ceilings | Low-medium with Turnstile on. A solved token still buys one run; budgets cap the rest |
| T6 | Webhook spoofing or replay at receivers | HMAC-SHA256 signature; V2 signature binds a timestamp (5 minute tolerance); `X-Jantra-Delivery` ID for deduplication | Low once receivers verify V2. V1 remains for compatibility and is replayable |
| T7 | Credential brute force, timing attacks, or rate-limit evasion via forwarded headers | `X-Forwarded-For` honoured only from internal proxy peers (`JANTRA_TRUSTED_PROXIES`); 256-bit keys, SHA-256 lookup, constant-time comparison, pre-auth rate limit | Low |
| T8 | Secrets in logs or artifacts | Audit redaction, metadata-only diagnostics, secrets never echoed by webhook routes | Low. Covered by the audit redaction regression |
| T9 | Audit log tampering | Append-only JSONL; every line hash-chained (`seq`, `prevHash`, `hash`), HMAC-SHA256 when `JANTRA_AUDIT_HMAC_KEY` is set; `GET /v1/runs/:id/audit/verify` (full scope) | Low-medium with the HMAC key set: edits, deletions, reorders and inserts are detected. Truncating the tail is only detectable against a head hash recorded elsewhere. Concurrent writers in separate processes can fork a chain, which the verifier reports |
| T10 | Origin reached directly, bypassing the edge | Public key held only at the edge; with `JANTRA_EDGE_SECRET` set, public-scope requests also need the edge's shared secret (constant-time check); the edge strips browser-supplied `X-Jantra-*` headers | Low with the secret set. Both secrets would have to leak. Network-level restriction to Cloudflare is still worthwhile |
| T12 | Vulnerable dependencies | CI `audit-gate` blocks high/critical advisories with a non-breaking fix; 2026-11-18 upgrade: fastify 5.12.8 (schema-validation bypass, router DoS), zod 4.6.7 (memory exhaustion), electron 42.11.18 (critical heap overflow, sandbox escape), electron-builder 26.18.0, electron-updater 6.8.11, vite 8.3.8 | Low-medium. picomatch (via Vite, build-time only) has no patched release and is reported as a warning |
| T13 | Leaked secrets in the repo | CI `secret-scan` over tracked files; full git history scanned clean on 2026-11-18 | Low |
| T14 | XSS via the exported client report (model, visitor and fetched-page text rendered as HTML) | Escaping before markdown formatting; `javascript:`/`data:` links dropped; code-fence language tags restricted; strict CSP (no script except the pinned print handler, no network loads, no framing) sent as a header **and** embedded as the first `<head>` element, because the web console opens the report as a `blob:` URL that runs in the console's origin with no headers; opened with `noopener` | Low. Verified in Chromium that an injected script is blocked in both the served and blob copies |
| T15 | Desktop app: external content gaining the privileged bridge (loopback/admin tokens, key-writing and backup-restore IPC) | Renderer sandbox on (preload rebuilt as CommonJS; the ESM preload previously failed to load under the default sandbox); http(s) links and `window.open` go to the system browser; report windows get an empty preload; main window cannot navigate off the app; IPC accepted only from the main window's app URL; all permission requests denied | Low. `desktop/test/electron-security.e2e.cjs` runs these checks in real Electron in CI |
| T16 | Credential ciphertext forgery or tampering at rest | AES-256-GCM, random 96-bit IV; decrypt enforces 12-byte IV and full 16-byte tag (Node otherwise accepts 4-byte tags) | Low. Ciphertexts are not bound to their record (no AAD), so someone with database write access could swap blobs between records |
| T17 | Desktop backup restore and audit export path abuse | Export IDs restricted to `[A-Za-z0-9_-]`; restore skips symlinks; IPC limited to the app UI | Low. Restoring overwrites local projects and audit by design; restore only trusted backups |
| T18 | Connection exhaustion via SSE event streams | Per-identity (`JANTRA_SSE_MAX_PER_IDENTITY`, default 10) and process-wide (`JANTRA_SSE_MAX_TOTAL`, default 500) caps; idempotent cleanup on close or error so a dead socket cannot crash the process; public keys cannot reach the stream | Low |
| T11 | Path traversal in data and connector paths | `assertSafePathSegment`; `resolveClientDataDir` containment plus rejection of absolute paths on any platform | Low |

## Webhook verification for receivers

Each signed delivery carries:

- `X-Jantra-Timestamp`: Unix seconds at send time.
- `X-Jantra-Signature-V2`: hex HMAC-SHA256 of `${timestamp}.${rawBody}` with the
  subscription secret.
- `X-Jantra-Signature`: legacy hex HMAC-SHA256 of `rawBody` (replayable;
  deprecated).
- `X-Jantra-Delivery`: stable event ID; store it and drop duplicates.

Reject a request when the timestamp is more than 300 seconds from your clock or
the V2 signature does not match under a constant-time comparison. The
reference implementation is `verifyWebhookSignature` in
`src/util/webhookSignature.ts`.

## Open recommendations (priority order)

1. Set `JANTRA_EDGE_SECRET` and `TURNSTILE_SECRET_KEY` in production; both controls are off until configured (T5, T10).
2. Periodically export each run's `headSeq`/`headHash` to storage outside the audit volume, so tail truncation is detectable (T9).
4. Add `npm audit --omit=dev` and secret scanning to CI.
3. Commission an external penetration test before production traffic.

## Regressions guarding this model

`webhook-url-guard`, `ssrf-ipv6-transition-ranges`, `safe-fetch-redirect`,
`webhook-signature-replay`, `injection-content-neutralized`,
`injection-bypass-corpus`, `public-key-scope`, `public-run-token-binding`, `edge-secret-origin-lock`, `rate-limiter-proxy-trust`,
`audit-redaction-truncation`, `audit-hash-chain`, `audit-verify-route`, `error-envelope-no-leak`, `csv-directory-resolve`, `env-reads-only-in-config`, `security-headers-report-csp`, `credential-encryption-strict`, `event-stream-limits`.
Desktop: `npm test -w @jantra/desktop` (policy unit tests) and `npm run test:e2e -w @jantra/desktop` (real Electron, 14 checks).
Edge checks (`npm run edge:verify:local`): Turnstile missing, forged, wrong-hostname and verifier-down cases; direct origin calls without or with a wrong edge secret; run access without or with a wrong run token; browser header smuggling.

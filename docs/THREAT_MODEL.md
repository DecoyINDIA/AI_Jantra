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
| T4 | Visitor reads another visitor's run | Run IDs are random UUIDv4 (bearer capability); public keys limited to an allowlist of routes and agents | Low-medium. Anyone holding a run ID can read and drive it. Bind runs to a visitor session token if run IDs ever appear in URLs, logs or referrers |
| T5 | Budget exhaustion through the public widget | Edge per-IP limiter, origin pre-auth limiter, identity limiter, per-visitor and per-client daily spend ceilings | Medium. IP-based visitor identity is weak against botnets; add a proof-of-work or Turnstile challenge before launch |
| T6 | Webhook spoofing or replay at receivers | HMAC-SHA256 signature; V2 signature binds a timestamp (5 minute tolerance); `X-Jantra-Delivery` ID for deduplication | Low once receivers verify V2. V1 remains for compatibility and is replayable |
| T7 | Credential brute force or timing attacks | 256-bit keys, SHA-256 lookup, constant-time comparison, pre-auth rate limit | Low |
| T8 | Secrets in logs or artifacts | Audit redaction, metadata-only diagnostics, secrets never echoed by webhook routes | Low. Covered by the audit redaction regression |
| T9 | Audit log tampering | Append-only JSONL | Medium. No tamper evidence. Recommended: hash-chain records |
| T10 | Origin reached directly, bypassing the edge | Public key held only at the edge; full keys required otherwise | Medium if the public key leaks. Recommended: restrict the origin to Cloudflare egress or add an edge-to-origin shared secret |
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

1. Bot challenge (Turnstile) on the public widget before the first paid model call (T5).
2. Lock the origin to the edge: Cloudflare-only ingress or a shared secret header (T10).
3. Hash-chain audit JSONL records so tampering is detectable (T9).
4. Visitor-bound run access tokens for public runs (T4).
5. Move the remaining `process.env` reads in `src/server/index.ts` and `src/server/auth/logtoUser.ts` into `src/config.ts`.
6. Add `npm audit --omit=dev` and secret scanning to CI.
7. Commission an external penetration test before production traffic.

## Regressions guarding this model

`webhook-url-guard`, `ssrf-ipv6-transition-ranges`, `safe-fetch-redirect`,
`webhook-signature-replay`, `injection-content-neutralized`,
`injection-bypass-corpus`, `public-key-scope`, `rate-limiter-proxy-trust`,
`audit-redaction-truncation`, `error-envelope-no-leak`, `csv-directory-resolve`.

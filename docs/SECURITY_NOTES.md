# Jantra Security Notes

- Gemini keys are stored through Electron `safeStorage` and are not exposed to the renderer.
- Local API calls require a per-launch loopback token.
- Hosted API mode requires API-key identity resolving to `clientId`.
- Every route must use server-derived tenancy. Callers do not supply `clientId`.
- Audit logs are append-only JSONL and may contain client context. Export them deliberately.
- Diagnostics are metadata-only by default and exclude prompts, raw artifacts, model responses, and secrets.
- API keys are scoped to either `full` or `public` access, restricting public callers to designated public agent IDs and safe routes (`src/server/scope.ts`).
- Remote endpoints apply pre-auth IP rate limits and identity-based sliding-window rate limits to prevent abuse (`src/server/rateLimit.ts`).
- Outbound webhooks and external requests are validated against private IP ranges, loopbacks, metadata services, and unpermitted schemes (`src/server/webhooks/urlGuard.ts`, `src/util/safeFetch.ts`).
- Per-client and per-visitor daily spend ceilings are enforced synchronously before executing runs or gateway model calls (`src/runtime/intakeBudget.ts`, `src/runtime/gatewayBudget.ts`).
- Lead records contain personal contact information stored as JSON files on disk under the configured data root (`src/server/leads/store.ts`).
- The outbound address blocklist also covers IPv6 forms that embed or translate IPv4 (IPv4-compatible `::/96`, 6to4 `2002::/16`, Teredo `2001::/32`, local NAT64 `64:ff9b:1::/48`, site-local `fec0::/10`) (`src/util/netGuard.ts`).
- Untrusted web content is NFKC-normalized and stripped of zero-width and bidi characters before injection detection, and is wrapped in a random-id fence that page content cannot forge (`src/policy.ts`). Pattern detection is a tripwire; deterministic citation verification and the human gate are the boundary.
- Webhooks carry `X-Jantra-Timestamp`, a timestamp-bound `X-Jantra-Signature-V2`, and `X-Jantra-Delivery` for deduplication. Receivers should verify V2 (see `docs/THREAT_MODEL.md`); the legacy `X-Jantra-Signature` is replayable.
- Threat model, residual risks, and open recommendations: `docs/THREAT_MODEL.md`.

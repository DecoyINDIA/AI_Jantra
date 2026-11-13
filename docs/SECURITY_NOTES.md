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

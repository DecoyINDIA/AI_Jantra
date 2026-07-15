# Jantra Security & Reliability Fixes Handoff (2026-07-15)

## Status
All two High-severity and four Medium-severity security and reliability fixes identified in the end-to-end review have been fully implemented, verified locally, and pushed directly to `main` as commit `35fcf87`.

---

## Detailed Handoff of Fixes

### Fix 1 (High) — Rate Limiter trusts a spoofable X-Forwarded-For chain
* **Files Modified:** [app.ts](file:///D:/XOLVER/Jantra/src/server/app.ts), [regressions.ts](file:///D:/XOLVER/Jantra/src/runtime/evals/regressions.ts)
* **Description:** Fastify `trustProxy` config changed from unbounded `true` to exactly `1` proxy hop in remote mode, disabling it in local mode.
* **Regression Test:** `verifyRateLimiterProxyTrust` checks that spoofed/client-prefixed `X-Forwarded-For` chains resolve correctly to the rightmost proxy-added client IP address, sharing the same rate-limit bucket.

### Fix 2 (High) — Webhook subscriptions are a blind SSRF primitive
* **Files Created/Modified:** [urlGuard.ts [NEW]](file:///D:/XOLVER/Jantra/src/server/webhooks/urlGuard.ts), [webhooks.ts](file:///D:/XOLVER/Jantra/src/server/routes/webhooks.ts), [delivery.ts](file:///D:/XOLVER/Jantra/src/server/webhooks/delivery.ts), [regressions.ts](file:///D:/XOLVER/Jantra/src/runtime/evals/regressions.ts)
* **Description:** Created `assertPublicWebhookUrl` to reject private/loopback IPv4/IPv6 ranges and non-HTTP(S) schemes. This is run both during webhook creation and immediately prior to outbound delivery.
* **Regression Test:** `verifyWebhookUrlGuard` verifies rejection of private IPv4, local hostnames, private ports, unsupported schemes, loopback IPv6, and approval of valid public IP literals.

### Fix 3 (Medium) — CI never runs the behavioral/security regression suite
* **Files Modified:** [.github/workflows/ci.yml](file:///D:/XOLVER/Jantra/.github/workflows/ci.yml)
* **Description:** Appended a new `behavioral-eval` job to run evaluation and smoke suites (`npm run eval`, `npm run smoke`, `npm run server:smoke`) in parallel with the main build job.

### Fix 4 (Medium) — Outbound HTTP calls have no timeout
* **Files Created/Modified:** [fetchWithTimeout.ts [NEW]](file:///D:/XOLVER/Jantra/src/util/fetchWithTimeout.ts), [webFetch.ts](file:///D:/XOLVER/Jantra/src/pipeline/research/webFetch.ts), [openaiCompatible.ts](file:///D:/XOLVER/Jantra/src/model/openaiCompatible.ts), [delivery.ts](file:///D:/XOLVER/Jantra/src/server/webhooks/delivery.ts), [stripe.ts](file:///D:/XOLVER/Jantra/src/pipeline/ops/connectors/stripe.ts), [shopify.ts](file:///D:/XOLVER/Jantra/src/pipeline/ops/connectors/shopify.ts), [gemini.ts](file:///D:/XOLVER/Jantra/src/model/gemini.ts)
* **Description:** Created a wrapper `fetchWithTimeout` to abort requests after a configurable timeout limit.
* **SDK Wrap:** Wrapped the Google GenAI SDK's `generateContent` in a `Promise.race` client-side timeout since it has no native signal abort capabilities, and disabled retrying upon timeout.

### Fix 5 (Medium) — `/v1/complete` gateway has no enforced cost ceiling
* **Files Created/Modified:** [config.ts](file:///D:/XOLVER/Jantra/src/config.ts), [store.ts](file:///D:/XOLVER/Jantra/src/pipeline/store.ts), [sqlite.ts](file:///D:/XOLVER/Jantra/src/pipeline/store/sqlite.ts), [gatewayBudget.ts [NEW]](file:///D:/XOLVER/Jantra/src/runtime/gatewayBudget.ts), [complete.ts](file:///D:/XOLVER/Jantra/src/server/routes/complete.ts), [app.ts](file:///D:/XOLVER/Jantra/src/server/app.ts), [regressions.ts](file:///D:/XOLVER/Jantra/src/runtime/evals/regressions.ts)
* **Description:** Added client gateway budget checking logic that halts execution and returns a 429 once the gateway daily spend cap (default $2.00) is exceeded.
* **Regression Test:** `verifyGatewayDailyBudget` verifies budget-exceeded clients are blocked and successful completions accumulate spend correctly.

### Fix 6 (Medium) — CSV ops connector directory escapes the client's data root
* **Files Modified:** [csv.ts](file:///D:/XOLVER/Jantra/src/pipeline/ops/connectors/csv.ts), [regressions.ts](file:///D:/XOLVER/Jantra/src/runtime/evals/regressions.ts)
* **Description:** Restricts configured directories to resolve relative to `data/ops/<clientId>` and throws an error if any traversal attempts escape the root.
* **Regression Test:** `verifyCsvDirectoryResolve` verifies that subdirectory resolve is valid, empty resolves to client root, and parent directory escape paths are rejected.

---

## Known Residual Gaps & Hygiene Items
* **Obfuscated IP Literals:** `net.isIP()` does not match decimal, octal, or hex obfuscations of loopback IPs (e.g. `http://2130706433/` for `127.0.0.1`). In standard environments, Node's DNS resolver fails to resolve these values as hostnames, so they do not bypass the guard, but a socket-connect level SSRF blocker is recommended for absolute safety.

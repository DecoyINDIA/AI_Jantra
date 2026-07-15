# Antigravity kickoff — fix the findings from the 2026-07-15 end-to-end review

> Paste this whole file to Antigravity. This is execution-ready, not plan-first: every fix below has exact file paths, current code, and the replacement. Investigate the surrounding file before editing (line numbers may drift), implement in the order given, and keep `npm run typecheck`, `npm run eval`, and `npm run smoke` green after every step.

---

You are Antigravity, implementing agent for **Jantra AI**. A full end-to-end review of this repo (server, pipeline, model providers, edge worker, embed widget, CI) found two High-severity issues and four Medium-severity issues. All six are scoped, understood, and ready to implement — no further investigation phase needed. Work through them **in the order listed** (later fixes assume nothing from earlier ones, but the order reflects risk × cost).

## Ground truth before you start

Confirm the baseline is clean before touching anything:
```bash
npm run typecheck
npm run eval     # 41/41 checks must pass
npm run smoke     # offline pipeline smoke, no API key needed
npm run server:smoke
```
All four must pass before your first commit and after every fix below. `npm run eval` includes the security regression suite (`src/runtime/evals/regressions.ts`) — treat any new failure there as a blocker, not noise.

## What exists — use it, do not reinvent

- **Atomic file writes:** `atomicWriteFileSync` pattern (temp file + `renameSync`) appears in `src/pipeline/store.ts`, `src/server/leads/store.ts`, `src/server/webhooks/store.ts`. Reuse this pattern if you add any new file-backed store.
- **Budget/ceiling pattern:** `src/runtime/intakeBudget.ts` is the reference implementation for "per-client daily spend ceiling with audit on exceed" — `recordIntakeSpend`, `enforceIntakeRunCeiling`, `clientDailyIdeationBudgetStatus`. Mirror this shape for the gateway budget fix (Medium #4 below) rather than inventing a new pattern.
- **HttpError / error mapping:** `src/server/errors.ts` — `HttpError`, `notFound`, `forbidden`, `unauthorized`, `conflict`, `sendHttpError`. Add a `badRequest(message, details?)` helper here if you need one; do not throw raw `Error` from routes.
- **Regression test pattern:** `src/runtime/evals/regressions.ts` already has `rate-limiter-fixed-window`, `runid-path-traversal`, and `injection-content-neutralized` checks. Add new checks there following the same `assert(...)` style so `npm run eval` covers them.
- **Config pattern:** `src/config.ts` — every tunable is `xFromEnv(name, fallback)` with a validating parse. Add new env vars there, not as inline `process.env.X` reads elsewhere.

---

## Fix 1 (High) — Rate limiter trusts a spoofable X-Forwarded-For chain

**File:** `src/server/app.ts`, around line 58-65.

**Problem:** `trustProxy: mode === "remote"` passes Fastify a boolean `true`. Per `@fastify/proxy-addr` semantics, boolean `true` trusts an *unbounded* X-Forwarded-For chain and resolves `request.ip` to the **leftmost** entry — which the client sets and fully controls. `src/server/rateLimit.ts` keys its fixed-window bucket on `request.ip`. A client that sends a fresh spoofed `X-Forwarded-For` header on every request gets a fresh bucket every time and the limiter never trips, defeating the flood/brute-force protection the code comments claim it provides.

**Fix:** Trust exactly one hop (the platform's own reverse proxy — Railway, or the Cloudflare Worker's outbound `fetch` passing through it), not an arbitrary chain.

```ts
// src/server/app.ts
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Trust exactly one hop: the platform's own reverse proxy. A boolean `true`
    // trusts an unbounded X-Forwarded-For chain and Fastify resolves request.ip
    // to the LEFTMOST entry, which is fully client-controlled — a spoofed header
    // lets a client rotate "IP" every request and bypass the rate limiter below.
    // A numeric trustProxy trusts N hops counted from the socket, i.e. only the
    // value appended by the immediately-connected, trusted proxy.
    trustProxy: mode === "remote" ? 1 : false,
  });
```

**Verify:**
1. `npm run server:smoke` still passes.
2. Add a regression to `src/runtime/evals/regressions.ts` (follow the existing `rate-limiter-fixed-window` check's structure): start a remote-mode server via `createServer`, `inject()` two requests with the same real remote address but two *different* spoofed `X-Forwarded-For` values, and assert they land in the same rate-limit bucket (second request's `X-RateLimit-Remaining` header is one less than the first's, not equal to `max - 1` both times).
3. Manually confirm: a request with `X-Forwarded-For: 1.2.3.4` and no real proxy in front (test harness) does **not** get treated as coming from `1.2.3.4` — `request.ip` should be the loopback/test socket address, not the spoofed header, since with `trustProxy: 1` and no actual intermediary, Fastify has zero real hops to trust from XFF and falls back to the socket address.

---

## Fix 2 (High) — Webhook subscriptions are a blind SSRF primitive

**Files:** new `src/server/webhooks/urlGuard.ts`; edit `src/server/routes/webhooks.ts`; edit `src/server/webhooks/delivery.ts`.

**Problem:** `POST /v1/webhooks` accepts any URL passing `z.string().url()` — no scheme restriction, no private/loopback/link-local check. `dispatchGateEvent` → `deliverWebhook` fires a server-side `fetch` to that URL on every gate transition, fire-and-forget (result never returned to the caller, only logged). Any API-key holder can register `http://169.254.169.254/latest/meta-data/...` (cloud metadata), `http://localhost:<internal-port>/...`, or an RFC-1918 address and make the origin probe internal infrastructure on a recurring trigger they control (create a run, drive it to a gate).

**Fix:** Validate the URL's resolved address against a private/loopback/link-local blocklist, both at subscription-create time and immediately before each delivery attempt (delivery-time check defends against DNS rebinding between registration and delivery).

Create `src/server/webhooks/urlGuard.ts`:
```ts
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::1" || n === "::") return true;
  if (n.startsWith("fc") || n.startsWith("fd")) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(n)) return true; // link-local fe80::/10
  const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // unrecognizable → treat as unsafe, do not silently allow
}

/**
 * Reject webhook URLs that could reach internal infrastructure: non-HTTP(S)
 * schemes, loopback/link-local/private hosts, and the cloud metadata endpoint.
 * The server fetches this URL with no caller-visible response, so an unchecked
 * URL is a blind SSRF primitive. Call this both at subscription-create time and
 * immediately before delivery (DNS can change between the two).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Webhook URL scheme must be http or https, got "${url.protocol}".`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Webhook URL host "${hostname}" is not allowed.`);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Webhook URL resolves to a private or internal address.");
    }
    return;
  }
  const records = await lookup(hostname, { all: true });
  if (!records.length) {
    throw new Error(`Webhook URL host "${hostname}" did not resolve.`);
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(`Webhook URL host "${hostname}" resolves to a private or internal address.`);
    }
  }
}
```

Edit `src/server/routes/webhooks.ts` — in the `POST /v1/webhooks` handler, validate before `store.create`:
```ts
import { HttpError } from "../errors.js";
import { assertPublicWebhookUrl } from "../webhooks/urlGuard.js";
// ...
  app.post("/v1/webhooks", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createWebhookBodySchema, request.body);
    try {
      await assertPublicWebhookUrl(body.url);
    } catch (err) {
      throw new HttpError(400, "invalid_webhook_url", err instanceof Error ? err.message : String(err));
    }
    const subscription = store.create({ /* unchanged */ });
    // ...
  });
```

Edit `src/server/webhooks/delivery.ts` — validate once at the top of `deliverWebhook`, before the retry loop, and treat a validation failure as terminal (log, do not throw uncaught into the fire-and-forget caller in `dispatcher.ts`, which already `.catch()`s):
```ts
import { assertPublicWebhookUrl } from "./urlGuard.js";
// ...
export async function deliverWebhook(
  subscription: WebhookSubscription,
  event: WebhookEvent,
  attempts = 3,
): Promise<void> {
  await assertPublicWebhookUrl(subscription.url);
  const body = JSON.stringify(event);
  // ...unchanged retry loop
}
```

**Verify:**
1. Add a regression to `src/runtime/evals/regressions.ts`: assert `assertPublicWebhookUrl("http://169.254.169.254/")`, `assertPublicWebhookUrl("http://localhost/")`, `assertPublicWebhookUrl("http://127.0.0.1:9999/")`, and `assertPublicWebhookUrl("ftp://example.com/")` all reject; assert `assertPublicWebhookUrl("https://example.com/hook")` resolves without throwing (this one needs network in CI — if the eval harness runs offline, mock/stub `dns.lookup` for this case, or scope the assertion to the IP-literal and scheme checks only, which need no network).
2. `POST /v1/webhooks` with `{"url": "http://169.254.169.254/"}` returns `400 invalid_webhook_url`, not `201`.
3. `npm run eval` and `npm run server:smoke` stay green.

---

## Fix 3 (Medium) — CI never runs the behavioral/security regression suite

**File:** `.github/workflows/ci.yml`.

**Problem:** CI gates merges on typecheck + build only. `npm run eval` (41 checks, including the path-traversal, rate-limiter, and prompt-injection-neutralization regressions) and `npm run smoke` run locally but never in CI — a regression in any guardrail passes review.

**Fix:** Add a job. Both commands need no API key (confirmed: `npm run eval` and `npm run smoke` pass with no `GEMINI_API_KEY` set; `smoke` sets `JANTRA_PROVIDER=mock` internally).

```yaml
  behavioral-eval:
    name: Behavioral eval + smoke
    runs-on: ubuntu-latest
    needs: typecheck
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Behavioral eval suite (guardrails + security regressions)
        run: npm run eval

      - name: Pipeline smoke test
        run: npm run smoke

      - name: Server smoke test
        run: npm run server:smoke
```

Add this as a new top-level job (parallel to `build`, both depending on `typecheck`) so it doesn't add to critical-path latency.

**Verify:** Push to a branch / open a PR and confirm the new job appears and passes in the Actions tab.

---

## Fix 4 (Medium) — Outbound HTTP calls have no timeout

**Files:** new `src/util/fetchWithTimeout.ts`; edit `src/pipeline/research/webFetch.ts`, `src/model/openaiCompatible.ts`, `src/server/webhooks/delivery.ts`, `src/pipeline/ops/connectors/stripe.ts`, `src/pipeline/ops/connectors/shopify.ts`.

**Problem:** No call site uses `AbortController`/`signal`. A hung source, model endpoint, webhook target, or Stripe/Shopify API stalls the request indefinitely. Because `/v1/runs/:runId/advance` holds `withRunLock` for the duration of the stage run (`src/pipeline/orchestrator.ts`), a hang there blocks every subsequent request for that run. `deploy/cloudflare-worker/worker.js` already has this pattern (`fetchWithTimeout`, 25s) — bring it into the Node origin.

**Fix:** Create the shared helper:
```ts
// src/util/fetchWithTimeout.ts
const DEFAULT_TIMEOUT_MS = 25_000;

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
```

Apply it at each call site, choosing a timeout appropriate to the call:
- `src/pipeline/research/webFetch.ts` — the `fetch(url, {...})` in `fetchPage`: `fetchWithTimeout(url, {...}, 20_000)`.
- `src/model/openaiCompatible.ts` — the `fetch(url, {...})` inside the retry loop in `generate()`: `fetchWithTimeout(url, {...}, 60_000)` (model calls, especially reasoning models, are slower).
- `src/server/webhooks/delivery.ts` — the `fetch(subscription.url, {...})`: `fetchWithTimeout(subscription.url, {...}, 10_000)`.
- `src/pipeline/ops/connectors/stripe.ts` and `shopify.ts` — the `fetch(...)` inside each connector's `get()` helper: `fetchWithTimeout(..., 15_000)`.

For `src/model/gemini.ts`: the `@google/genai` SDK call (`this.ai.models.generateContent(request)`) is not a raw `fetch`, so `fetchWithTimeout` does not apply directly. Check whether the installed `@google/genai` version's `generateContent` accepts an `AbortSignal` (inspect its TypeScript types). If it does, thread one through with the same timeout budget as the retry loop. If it does not, wrap the call in a `Promise.race` against a timeout that rejects with a `ModelProviderError` — note in a comment that this bounds *your* wait but cannot cancel the in-flight SDK request, which is a real but acceptable limitation (document it, don't silently skip the fix).

**Verify:**
1. `npm run typecheck` — the helper's return type must match every call site's existing `Response` usage.
2. `npm run eval` and `npm run smoke` stay green (the mock provider path in `MockProvider` doesn't use `fetch`, so this should be a no-op for the offline suite).
3. Manually: point a research fetch or a webhook subscription at an address that never responds (e.g. a TCP port with nothing listening, or a `10.255.255.1` blackhole address before Fix 2's guard would reject it) and confirm the call fails after the configured timeout rather than hanging.

---

## Fix 5 (Medium) — `/v1/complete` gateway has no enforced cost ceiling

**Files:** `src/config.ts`; new `src/runtime/gatewayBudget.ts`; edit `src/pipeline/store.ts` (interface + `JsonProjectStore`); edit `src/pipeline/store/sqlite.ts`; edit `src/server/routes/complete.ts`.

**Problem:** In `src/server/routes/complete.ts`, when `result.costUsd > config.gatewayRunCeilingUsd` the handler only records an audit entry (`gateway_cost_exceeded`) — it still returns the result. There is no daily aggregate cap. An authenticated client can run arbitrary prompts billed to the server's model key indefinitely, bounded only by the per-IP rate limit (120/min default) and the 2000-token `maxOutputTokens` cap in the request schema.

**Fix:** Mirror the intake budget pattern (`src/runtime/intakeBudget.ts`) exactly: a per-client daily ceiling, checked *before* the call and enforced (429), with spend recorded after.

1. Add to `src/config.ts`, alongside the other ceilings:
```ts
  gatewayClientDailyCeilingUsd: numberFromEnv("JANTRA_GATEWAY_DAILY_CEILING_USD", 2.0),
```

2. Extend the `ProjectStore` interface in `src/pipeline/store.ts` with a second spend bucket (do not reuse the ideation bucket — conflating the two budgets would let gateway traffic consume intake budget and vice versa):
```ts
export interface ProjectStore {
  // ...existing members
  getClientDailyGatewaySpend(clientId: string, dayUtc: string): number;
  addClientDailyGatewaySpend(clientId: string, dayUtc: string, deltaUsd: number): void;
}
```
Implement in `JsonProjectStore` following the exact shape of `getClientDailyIdeationSpend`/`addClientDailyIdeationSpend`, but backed by a sibling file `gateway-spend.json` (reuse the existing `readSpend`-style helper, parameterized by filename, rather than copy-pasting — factor `spendFile`/`readSpend`/`atomicWriteFileSync` calls into a small generic `readNamedSpend(clientId, filename)` / `writeNamedSpend(...)` pair used by both the ideation and gateway buckets).

3. Implement the same two methods in `src/pipeline/store/sqlite.ts`, adding a sibling table:
```ts
    this.db.exec(`
      create table if not exists client_daily_gateway_spend (
        client_id text not null,
        day_utc text not null,
        usd real not null,
        primary key (client_id, day_utc)
      )
    `);
```
with `getClientDailyGatewaySpend`/`addClientDailyGatewaySpend` mirroring the existing `getClientDailyIdeationSpend`/`addClientDailyIdeationSpend` implementations against this new table.

4. Create `src/runtime/gatewayBudget.ts` mirroring `src/runtime/intakeBudget.ts`'s shape (`intakeBudgetDayUtc`, `clientDailyIdeationBudgetStatus`, `auditClientDailyIdeationBudgetExceeded`) but for the gateway bucket — reuse `intakeBudgetDayUtc` directly (it's just UTC-day formatting, not intake-specific) rather than duplicating it; export a `clientDailyGatewayBudgetStatus(store, clientId)` and `recordGatewaySpend(store, clientId, deltaUsd)`.

5. Edit `src/server/routes/complete.ts`: check budget before calling the provider, return 429 if exceeded (same shape as the `client_daily_ideation_budget_exceeded` 429 in `src/server/routes/runs.ts`); after the call, record spend regardless of whether the per-call `gatewayRunCeilingUsd` audit fires.

**Verify:**
1. Add a regression to `src/runtime/evals/regressions.ts` asserting: a client under the daily ceiling can call `/v1/complete` (or the equivalent unit-level function) and it succeeds; a client already at/over the ceiling gets rejected before the model call is made (assert the mock provider's call count does not increase).
2. `npm run eval` stays green.
3. Manually drive `/v1/complete` past the configured `JANTRA_GATEWAY_DAILY_CEILING_USD` (set it low, e.g. `0.0001`, for the test) and confirm the second call returns 429 with `code: "gateway_daily_budget_exceeded"`.

---

## Fix 6 (Medium) — CSV ops connector directory escapes the client's data root

**File:** `src/pipeline/ops/connectors/csv.ts`, in `CsvConnector.fetch`, around line 132-137.

**Problem:** `cfg.config.directory` comes from the source-binding artifact — model-generated JSON, parsed in `src/pipeline/stages/opsReporting.ts` (`JSON.parse` of a regex-matched block) — and is used verbatim: `const dir = cfg.config.directory || path.join("data", "ops", clientId);`. There is no constraint keeping a supplied `directory` under the client's own data root, unlike `assertSafePathSegment` in `src/pipeline/store.ts` which guards the equivalent path in the project store. A binding steered (via a poisoned/adversarial ops-onboarding conversation) to `directory: "../../../etc"` or an absolute path reads arbitrary CSV-parseable files into a generated report.

**Fix:** Always resolve `directory` relative to the client's own root and reject any resolution that escapes it.

```ts
// src/pipeline/ops/connectors/csv.ts
const OPS_DATA_ROOT = path.resolve("data", "ops");

function resolveClientDataDir(clientId: string, requested?: string): string {
  const base = path.resolve(OPS_DATA_ROOT, clientId);
  if (!requested) return base;
  const resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(
      `Ops CSV connector directory escapes the client's data root: "${requested}".`,
    );
  }
  return resolved;
}
```
Replace the current directory line inside `fetch`:
```ts
    const dir = resolveClientDataDir(clientId, cfg.config.directory);
```
This changes semantics deliberately: a configured `directory` is now always interpreted relative to `data/ops/<clientId>/`, never as an absolute path elsewhere on disk. Note this in the diff/PR description since it's an intentional behavior change, not just a bug fix.

**Verify:**
1. Add a regression to `src/runtime/evals/regressions.ts`: assert `resolveClientDataDir("acme", "../../etc")` throws, and `resolveClientDataDir("acme", "subdir")` resolves under `data/ops/acme/subdir`.
2. `npm run eval` stays green.
3. Re-run the existing `data-quality-battery-eval` and `ops-adversarial-injection-eval` checks (already in the eval suite) — they must still pass unchanged, confirming legitimate CSV loading still works.

---

## Constraints for every fix

- TypeScript strict, ESM, Node ≥ 20 — matches the rest of the repo.
- No new runtime dependencies. Every fix above is implementable with `node:*` built-ins and existing project patterns.
- Do not touch `src/runtime/evals/fixtures/**` — those are golden fixtures for existing checks.
- Every new regression check goes into `src/runtime/evals/regressions.ts` following its existing `assert(condition, message)` style, and must be additive (do not remove or weaken an existing check).
- Keep `npm run typecheck`, `npm run eval`, `npm run smoke`, and `npm run server:smoke` green after **every individual fix**, not just at the end — commit fix-by-fix so a regression is bisectable.
- If any fix reveals the code at the cited line has drifted since this doc was written, re-read the current file and adapt — the intent (not the exact line number) is the spec.

## Definition of done

- [x] Fix 1: `trustProxy` bounded to 1 hop in remote mode; new XFF-spoof regression passes.
- [x] Fix 2: `assertPublicWebhookUrl` created, wired into both subscription-create and delivery; new SSRF regression passes; `POST /v1/webhooks` with a metadata-endpoint URL returns 400.
- [x] Fix 3: CI runs `npm run eval` + `npm run smoke` + `npm run server:smoke` on every PR.
- [x] Fix 4: `fetchWithTimeout` created and applied to webFetch, openaiCompatible, webhook delivery, and both ops connectors; Gemini SDK call timeout handled or explicitly documented as a known limitation.
- [x] Fix 5: Gateway daily budget enforced (429 before call, not audit-after); new regression confirms rejection with zero model calls made once over budget.
- [x] Fix 6: CSV connector directory confined to the client's data root; new regression confirms traversal is rejected and legitimate relative paths still work.
- [x] `npm run typecheck && npm run eval && npm run smoke && npm run server:smoke` all pass on the final state.
- [x] Nothing in `src/runtime/evals/fixtures/**` was modified.

## Output

Implement all six fixes in order, committing after each one with the four verification commands passing. When done, summarize what changed per fix and confirm the final green run of all four commands.

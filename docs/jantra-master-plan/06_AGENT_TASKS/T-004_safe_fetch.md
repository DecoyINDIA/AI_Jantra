# TASK ID: T-004

**Title:** Outbound request guard (`safeFetch`)
**Priority:** P0
**Objective:** Every request to a URL supplied by a caller or a model goes through one function that refuses private and reserved addresses, including after redirects and at connection time.
**Why This Matters:** The webhook guard accepts `http://[::ffff:127.0.0.1]/`, follows redirects to internal hosts, and re-resolves DNS after checking; the research fetcher has no guard (Audit A-05).
**Prerequisites:** none.
**Effort & Complexity:** Medium to large; high reasoning (network edge cases).
**Recommended Agent Tier:** Advanced agent required. Independent review required.

---

## Standalone Execution Prompt

```
You are implementing task T-004 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/server/webhooks/urlGuard.ts exports assertPublicWebhookUrl(rawUrl): checks scheme, a blocked-hostname
  set, literal IPs with hand-written isPrivateIPv4/isPrivateIPv6, then dns lookup({all:true}) and checks
  each address. Known gaps: IPv4-mapped IPv6 in hex form (new URL("http://[::ffff:127.0.0.1]/").hostname is
  "[::ffff:7f00:1]"), 100.64.0.0/10, 198.18.0.0/15, 64:ff9b::/96, multicast, redirects, DNS rebinding.
- src/server/webhooks/delivery.ts calls assertPublicWebhookUrl then fetchWithTimeout(subscription.url, …, 10_000).
- src/server/routes/webhooks.ts calls assertPublicWebhookUrl at subscription time (keep).
- src/pipeline/research/webFetch.ts fetchPage(url, titleHint): handles file:// only under the mock provider,
  checks scheme is http/https, then fetchWithTimeout(url, {headers:{User-Agent…}}, 20_000) and response.text().
- src/util/fetchWithTimeout.ts: fetchWithTimeout(input, init, timeoutMs) using AbortController.
- Node >= 20. `net.BlockList` treats IPv4-mapped IPv6 addresses as their IPv4 form when checked with family
  "ipv6" against IPv4 rules. CONFIRM this in the Node docs for net.BlockList before relying on it, and cover it
  with a test either way.
- You MAY add the npm package `undici` as a runtime dependency of the root package (needed to pin the
  connection address). No other new dependency.

FILES TO CREATE / MODIFY
- src/util/netGuard.ts (new)        address classification
- src/util/safeFetch.ts (new)       guarded fetch
- src/server/webhooks/urlGuard.ts   delegate to netGuard (keep the exported function name and behaviour)
- src/server/webhooks/delivery.ts   use safeFetch
- src/pipeline/research/webFetch.ts use safeFetch for http/https
- package.json, package-lock.json   add undici
- src/runtime/evals/regressions.ts  extend "webhook-url-guard", add "safe-fetch-redirect"

INTERFACES
// src/util/netGuard.ts
export function isBlockedAddress(address: string): boolean;   // true for anything not a public unicast IP
export async function assertPublicHost(hostname: string): Promise<string[]>; // returns resolved addresses; throws Error
// src/util/safeFetch.ts
export interface SafeFetchOptions { timeoutMs?: number; maxRedirects?: number; maxBytes?: number; }
export async function safeFetch(url: string, init?: RequestInit, opts?: SafeFetchOptions): Promise<Response>;
export class UnsafeUrlError extends Error {}

IMPLEMENTATION STEPS
1. netGuard.ts: build one module-level net.BlockList and add subnets:
   IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24,
         192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
   IPv6: ::/128, ::1/128, 64:ff9b::/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8
   isBlockedAddress(a): v = net.isIP(a); if v === 0 return true; return list.check(a, v === 4 ? "ipv4" : "ipv6").
   If the mapped-IPv6 behaviour is NOT handled by BlockList on the installed Node, add explicit handling:
   parse the last 32 bits of any address in ::ffff:0:0/96 into dotted IPv4 and check that.
   assertPublicHost(hostname): strip surrounding [ ]; lowercase; reject "localhost", "localhost.localdomain"
   and any name ending in ".localhost", ".local", ".internal"; if net.isIP(host) → throw if blocked, return
   [host]; else dns.lookup(host, { all: true }) → throw if empty or if ANY address is blocked; return addresses.
2. safeFetch.ts:
   - Defaults: timeoutMs 20000, maxRedirects 3, maxBytes 5_000_000.
   - Loop up to maxRedirects + 1 times:
       parse URL; require protocol http: or https:; reject if username/password present;
       await assertPublicHost(url.hostname);
       create an undici Agent whose connect option supplies a custom `lookup` that resolves the hostname,
       rejects (callback error) if any resolved address is blocked, and returns only checked addresses — this
       closes the gap between the check and the connection;
       call undici's fetch (import { fetch as undiciFetch, Agent } from "undici") with
       { ...init, redirect: "manual", dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) };
       if status is 301/302/303/307/308: read Location, resolve against the current URL, for 303 (and for
       301/302 on POST) switch to GET with no body, close the agent, continue the loop;
       otherwise return the response (close the agent when the body has been consumed or on error).
   - Exceeding maxRedirects → throw UnsafeUrlError("Too many redirects.").
   - Enforce maxBytes: if Content-Length exceeds it, abort and throw; otherwise wrap the body so reading stops
     with an error once maxBytes is exceeded.
   - All refusals throw UnsafeUrlError with a message that does not echo resolved internal addresses.
3. urlGuard.ts: keep `export async function assertPublicWebhookUrl(rawUrl)`; implement it as scheme check
   plus assertPublicHost; delete the hand-written range functions. Error messages may change; keep that they throw.
4. delivery.ts: replace fetchWithTimeout(subscription.url, {...}, 10_000) with
   safeFetch(subscription.url, {...}, { timeoutMs: 10_000, maxRedirects: 0, maxBytes: 64_000 }).
   A redirect response from a webhook endpoint is treated as a non-retryable failure. Keep the existing
   assertPublicWebhookUrl call and retry logic.
5. webFetch.ts: for http/https, replace fetchWithTimeout(...) with
   safeFetch(url, { headers: {...same User-Agent...} }, { timeoutMs: 20_000, maxRedirects: 3, maxBytes: 3_000_000 }).
   Leave the file:// mock branch unchanged.
6. Regressions (offline only):
   - Extend verifyWebhookUrlGuard's badUrls with: "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
     "http://100.64.0.1/", "http://198.18.0.1/", "http://[64:ff9b::7f00:1]/", "http://user:pass@1.1.1.1/"
     (the last one via safeFetch, not the URL guard), "http://foo.localhost/".
   - Add unit asserts on isBlockedAddress: true for 127.0.0.1, 10.1.2.3, 169.254.169.254, ::1, fd00::1,
     ::ffff:10.0.0.1; false for 1.1.1.1, 8.8.8.8, 2606:4700:4700::1111.
   - "safe-fetch-redirect": start node:http servers on 127.0.0.1 is not usable through safeFetch (loopback is
     blocked, which is the point). Therefore test the redirect logic by exporting from safeFetch.ts a pure
     helper `nextRequest(currentUrl, status, location, method)` returning { url, method, dropBody } and assert:
     relative Location resolves; 303 → GET, dropBody; 307 keeps method; missing Location throws.
     Then assert safeFetch("http://127.0.0.1:9/") rejects with UnsafeUrlError without opening a socket.

EDGE CASES
- Hostnames with trailing dot ("example.com.") → strip one trailing dot before checks.
- IDN / punycode: use url.hostname as given by the URL parser.
- DNS returns a mix of public and private addresses → refuse.
- HTTPS certificate validation stays on; never set rejectUnauthorized false.
- AbortSignal.timeout must cover DNS + connect + headers; body reads are bounded by maxBytes.
- Offline CI: only literal IPs in tests; no test may need DNS.

NON-GOALS
- Do not guard model-provider calls, Stripe, Shopify or the FireBNB functions URL (operator-configured hosts).
- Do not add an allowlist feature. Do not change the webhook HTTP API.

ACCEPTANCE CRITERIA
1. npx tsc -p tsconfig.json --noEmit exits 0.
2. npm run eval exits 0 with the extended webhook-url-guard and new safe-fetch-redirect checks passing.
3. npm run smoke and npm run server:smoke exit 0 (smoke uses file:// under mock and must be unaffected).
4. `grep -rn "fetchWithTimeout" src/server/webhooks src/pipeline/research` returns nothing.

RISK & ROLLBACK
- Risk: legitimate research sources behind unusual redirects or large pages are skipped; they are already
  handled as a rejected citation and audited, so the stage continues. Rollback: revert the commit.

ESCALATION CONDITIONS — stop and report if:
- undici's Agent `connect.lookup` hook does not exist or behaves differently in the installed version.
- The Docker build cannot install undici (it has no native code; failure would be unexpected).
- net.BlockList is unavailable or its behaviour contradicts step 1 in a way you cannot cover with a test.

Finish with the report format from 07_AGENT_CONTEXT.md.
```

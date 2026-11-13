# TASK ID: T-005

**Title:** Discovery: what client address does the origin see behind the edge?
**Priority:** P1
**Objective:** A one-page factual answer, with captured header values, to "what are `request.ip` and the forwarding headers at the origin for a request that came through the Cloudflare Worker?"
**Why This Matters:** If the origin sees Cloudflare's egress address, all visitors share one 120/minute bucket (Audit A-06). T-006's design depends on the answer.
**Prerequisites:** none. Needs an operator with access to the staging or production origin logs, or a local Worker + origin.
**Effort & Complexity:** Small; low reasoning. Read-only.
**Recommended Agent Tier:** Small agent (with operator assistance for deployed environments).

---

## Standalone Execution Prompt

```
You are doing a bounded DISCOVERY task (T-005) for the Jantra AI repository. You change no source files.
Time box: stop after the steps below even if some answers are "could not determine".

BACKGROUND
- Edge: deploy/cloudflare-worker/worker.js copies all inbound headers (new Headers(request.headers)), sets
  Authorization, deletes Origin and Cookie, and fetches the origin.
- Origin: src/server/app.ts creates Fastify with trustProxy: 1 in remote mode; src/server/rateLimit.ts keys the
  limiter on request.ip.

STEPS
1. Local reproduction (no deployed access needed). Follow deploy/cloudflare-worker/README.md "Local development":
   run the origin with JANTRA_PROVIDER=mock JANTRA_REMOTE_API_KEYS=edge-test-key:xolver:web
   JANTRA_SERVER_PORT=4327 npm run server:remote, and the Worker with `wrangler dev worker.js --local …`.
   Send one POST /v1/runs through the Worker with header "X-Forwarded-For: 203.0.113.9" and
   "X-Jantra-Client-IP: 203.0.113.9". To see what the origin received WITHOUT editing the repo, run a throwaway
   listener instead of the origin for one request (for example `node -e` with http.createServer that prints
   req.headers and req.socket.remoteAddress and returns 200 {}), pointing the Worker's JANTRA_ORIGIN at it.
2. Record: the full header list received; whether client-supplied X-Forwarded-For and X-Jantra-Client-IP
   arrive unchanged; whether CF-Connecting-IP is present on the subrequest.
3. If an operator can provide it: the same capture from the deployed origin (one request), or the response
   headers X-RateLimit-Remaining from two requests sent from two different networks within one minute
   (if the second network sees a decremented value, the bucket is shared).
4. Read the Cloudflare Workers documentation on request headers added to subrequests and note the relevant
   sentences with URLs.

DELIVERABLE (write as your final message, not as a repo file)
- Table: header name | value seen locally | value seen deployed (or "not available") | client-controllable? (yes/no)
- Answer A: Is request.ip at the origin the visitor's address? (yes / no / unknown) with evidence.
- Answer B: Can a browser client inject X-Jantra-Client-IP through the current Worker? (yes / no) with evidence.
- Recommendation in two lines: confirm or reject the T-006 design "Worker deletes inbound X-Jantra-Client-IP,
  sets it from CF-Connecting-IP; origin trusts it only for public-scope keys".

NON-GOALS: no code changes, no deployments, no load testing against production.

ESCALATION: if you cannot run wrangler locally and no operator is available, report that and stop.
```

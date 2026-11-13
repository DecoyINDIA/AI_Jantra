# TASK ID: T-006

**Title:** Per-visitor rate limit and intake budget
**Priority:** P1
**Objective:** Public traffic is throttled and budgeted per visitor, so one visitor cannot exhaust the shared rate bucket or the tenant's daily intake budget.
**Why This Matters:** Lead capture can be switched off for everyone by one abusive client (Audit A-06).
**Prerequisites:** T-001 (identity scope), T-005 (confirms the header design). Do not start if T-005 rejected the design.
**Effort & Complexity:** Medium; moderate reasoning (hook order).
**Recommended Agent Tier:** Medium-capability agent.

---

## Standalone Execution Prompt

```
You are implementing task T-006 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.
T-001 is merged: request.identity has scope "full" | "public".

REPOSITORY CONTEXT
- deploy/cloudflare-worker/worker.js builds `headers = new Headers(request.headers)`, sets Authorization,
  deletes Origin and Cookie, then fetches the origin. It reads the visitor address from CF-Connecting-IP for
  its own limiter.
- src/server/app.ts (remote mode): installRateLimit(...) is registered BEFORE installApiKeyAuth(...), so the
  limiter runs before identity exists. src/server/rateLimit.ts keys on request.ip.
- Daily intake budget: src/runtime/intakeBudget.ts. clientDailyIdeationBudgetStatus(store, clientId) is checked
  in src/server/routes/runs.ts before creating an intake-public run; recordIntakeSpend(store, project, stage,
  deltaUsd) adds spend under project.clientId. Storage: store.getClientDailyIdeationSpend /
  addClientDailyIdeationSpend(clientId, dayUtc, usd).
- Project type (src/pipeline/types.ts) has no field for the visitor.

FILES TO MODIFY
- deploy/cloudflare-worker/worker.js
- src/config.ts
- src/server/visitor.ts (new)
- src/server/rateLimit.ts, src/server/app.ts
- src/pipeline/types.ts (ONE optional field, authorised by this packet)
- src/pipeline/orchestrator.ts (CreateProjectOptions + createProject only)
- src/server/routes/runs.ts
- src/runtime/intakeBudget.ts
- src/runtime/evals/regressions.ts, .env.example

IMPLEMENTATION STEPS
1. worker.js, right after `const headers = new Headers(request.headers);`:
     for (const name of [...headers.keys()]) { if (name.toLowerCase().startsWith("x-jantra-")) headers.delete(name); }
     const visitorIp = request.headers.get("CF-Connecting-IP");
     if (visitorIp) headers.set("X-Jantra-Client-IP", visitorIp);
   EXCEPTION: keep "x-jantra-user" (the Logto user token header used by the leads route) — do not delete it.
2. src/config.ts: add intakeVisitorDailyCeilingUsd: numberFromEnv("JANTRA_INTAKE_VISITOR_DAILY_CEILING_USD", 0.10).
3. src/server/visitor.ts (new):
     export function visitorAddress(request: FastifyRequest): string
       → if request.identity?.scope === "public", read header "x-jantra-client-ip" (first value, trimmed);
         if net.isIP(value) !== 0 return it; otherwise return request.ip.
     export function visitorKey(request: FastifyRequest): string
       → sha256 hex of visitorAddress(request), first 16 chars.
4. Rate limiting:
   a. Keep the existing pre-auth limiter exactly as is (protects against key brute force) but raise nothing.
   b. In app.ts, AFTER installApiKeyAuth(...), add a second limiter via a new exported
      installIdentityRateLimit(app, { windowMs, max }) in rateLimit.ts: onRequest hook for /v1 paths, skipped
      when request.identity is undefined; key = `${request.identity.subject}|${visitorAddress(request)}`;
      same 429 body as the existing limiter. Use config.rateLimitWindowMs and a new
      config.publicVisitorRateLimitMax (env JANTRA_PUBLIC_VISITOR_RATE_LIMIT_MAX, default 30) for public scope
      and config.rateLimitMax for full scope.
   c. Because every public request shares the edge's address, raise the PRE-auth limiter's effective ceiling
      for safety: multiply its max by 10 (config.rateLimitMax * 10). Document why in a comment.
5. Visitor budget:
   a. src/pipeline/types.ts: add to Project `visitorKey?: string;` with a one-line comment.
   b. orchestrator.ts: add `visitorKey?: string` to CreateProjectOptions and copy it into the project object.
   c. runs.ts POST /v1/runs: compute `const vKey = request.identity?.scope === "public" ? visitorKey(request)
      : undefined;` pass visitorKey: vKey to createProject. For public scope, before creating the run, check
      visitorDailyBudgetStatus(deps.store, clientId, vKey) and on exceeded return 429 with code
      "visitor_daily_budget_exceeded" (same envelope shape as the client budget response).
      Apply BOTH client and visitor checks to every agent a public key may start, not only intake-public:
      change the condition `definition.id === PUBLIC_INTAKE_AGENT_ID` to `request.identity?.scope === "public"
      || definition.id === PUBLIC_INTAKE_AGENT_ID`.
   d. intakeBudget.ts:
      - export function visitorSpendId(clientId, visitorKey) { return `${clientId}#${visitorKey}`; }
      - export function visitorDailyBudgetStatus(store, clientId, visitorKey, now = new Date()) mirroring
        clientDailyIdeationBudgetStatus but reading store.getClientDailyIdeationSpend(visitorSpendId(...), day)
        against config.intakeVisitorDailyCeilingUsd (0 disables).
      - in recordIntakeSpend, after the existing add, if project.visitorKey add the same delta under
        visitorSpendId(project.clientId, project.visitorKey).
      - recordIntakeSpend currently returns early unless stage === "intake" and the agent is intake-public.
        Leave that condition unchanged in this task (other public agents are covered by run creation checks).
   e. JsonProjectStore writes spend under clientDir(clientId); "#" is a legal path character but confirm
      assertSafePathSegment accepts it (it rejects only separators, NUL, "." and ".."). SQLite needs no change.
6. .env.example: document the two new variables.
7. Regressions:
   - "visitor-rate-limit": remote app with a public key; 31 POST /v1/runs requests with header
     x-jantra-client-ip: 198.51.100.1 → the 31st is 429; one request with 198.51.100.2 → not 429.
     Use an injected small max by constructing the limiter directly if app-level config cannot be overridden;
     prefer testing installIdentityRateLimit with explicit options on a bare fastify() instance.
   - "visitor-header-ignored-for-full-keys": full-scope identity with the header set → key uses request.ip
     (assert via visitorAddress with stub request objects).
   - "visitor-daily-budget": seed store.addClientDailyIdeationSpend(visitorSpendId("t1", key), day, 0.2);
     visitorDailyBudgetStatus → exceeded true; a different key → false.

EDGE CASES
- Header missing or not an IP → fall back to request.ip; never throw.
- IPv6 visitors: use the address as given (no /64 grouping in this task).
- Old runs without visitorKey must load and run unchanged.

NON-GOALS: no change to the Worker's own limiter, no CAPTCHA, no new storage table.

ACCEPTANCE CRITERIA
1. npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0.
2. The three regressions pass. 3. worker.js still passes `node --check deploy/cloudflare-worker/worker.js`.

RISK & ROLLBACK
- Deploy origin first (it ignores a missing header), then the Worker. Rollback: revert Worker, then origin.
- JANTRA_INTAKE_VISITOR_DAILY_CEILING_USD=0 disables the visitor budget without a deploy.

ESCALATION CONDITIONS — stop and report if T-005's result says the Worker cannot reliably set the header, or
if deploy/cloudflare-worker/verify-edge.mjs asserts header pass-through that step 1 would break.

Finish with the report format from 07_AGENT_CONTEXT.md.
```

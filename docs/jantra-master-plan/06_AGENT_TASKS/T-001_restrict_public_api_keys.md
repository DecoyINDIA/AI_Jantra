# TASK ID: T-001

**Title:** Restrict public API keys to public agents and routes
**Priority:** P0
**Objective:** A key used by the public edge can only create and drive runs of allow-listed agents, cannot set `autonomy` or `modelId`, and cannot reach any other route.
**Why This Matters:** Today the widget's service key can start the full planning pipeline with auto-approval on the most expensive model, at up to $10 per run, from anonymous traffic (Audit A-01).
**Prerequisites:** none. Owner decision D-1 is resolved (2026-11-12): the public allowlist is `intake-public` and `firebnb-concierge`, which is the default in this packet.
**Effort & Complexity:** Medium effort; moderate reasoning (hook ordering, two auth paths).
**Recommended Agent Tier:** Medium-capability agent. Independent review required (Quality Gates §5).

---

## Standalone Execution Prompt

```
You are implementing task T-001 in the Jantra AI repository (TypeScript, Fastify 5, Zod 4, ESM).
Read 07_AGENT_CONTEXT.md first. Do exactly what is specified here; do not redesign.

REPOSITORY CONTEXT
- Remote mode auth: src/server/auth/apiKeys.ts. installApiKeyAuth() adds an onRequest hook that sets
  request.identity = { subject, clientId, mode: "remote" } from either a DB key (looked up by SHA-256 hash)
  or an env record parsed by parseApiKeyRecords() from JANTRA_REMOTE_API_KEYS ("key:clientId[:subject]").
- Identity type: src/server/tenancy.ts.
- Run creation: src/server/routes/runs.ts, POST /v1/runs (lines 49-112). Body schema createRunBodySchema in
  src/server/schemas.ts accepts agentId, title, input, modelId, autonomy.
- A Cloudflare Worker in front forwards browser bodies unchanged with the service key attached. The documented
  service key record is "<key>:xolver:web" (subject "web").
- Local mode (installLocalSecurity) never sets request.identity; local callers are fully trusted.

FILES TO INSPECT
- src/server/tenancy.ts, src/server/auth/apiKeys.ts, src/server/app.ts, src/server/errors.ts
- src/server/routes/runs.ts, src/server/routes/interactions.ts
- src/config.ts
- src/runtime/evals/regressions.ts (pattern for new checks; see verifyRateLimiterProxyTrust for app.inject use)

FILES TO MODIFY / CREATE
- src/config.ts                      add two settings
- src/server/tenancy.ts              extend Identity
- src/server/auth/apiKeys.ts         compute scope; enforce route allowlist
- src/server/scope.ts (new)          scope helpers
- src/server/routes/runs.ts          enforce on create and on run-scoped handlers
- src/server/routes/interactions.ts  enforce on both handlers
- src/runtime/evals/regressions.ts   new regression "public-key-scope"
- .env.example                       document the two variables

IMPLEMENTATION STEPS
1. src/config.ts — add to the exported config object:
     publicSubjects: list from env JANTRA_PUBLIC_SUBJECTS (comma separated, trimmed, empty items dropped);
                     when the variable is UNSET default to ["web"]; when set to an empty string the list is [].
     publicAgentIds: list from env JANTRA_PUBLIC_AGENT_IDS; default ["intake-public", "firebnb-concierge"].
   Write a small helper listFromEnv(name, fallback: string[]) next to the other *FromEnv helpers.
2. src/server/tenancy.ts — change Identity to:
     export type KeyScope = "full" | "public";
     export interface Identity { subject: string; clientId: string; mode: "local" | "remote";
                                 scope: KeyScope; allowedAgentIds?: string[]; }
3. src/server/scope.ts (new) — export:
     scopeForSubject(subject: string): { scope: KeyScope; allowedAgentIds?: string[] }
        → public (with config.publicAgentIds copy) when config.publicSubjects includes subject, else full.
     isPublicRouteAllowed(method: string, path: string): boolean
        → true only for these (path = URL without query string):
          POST ^/v1/runs$ | GET ^/v1/runs/[^/]+$ | POST ^/v1/runs/[^/]+/advance$ |
          GET ^/v1/runs/[^/]+/interactions$ | POST ^/v1/runs/[^/]+/interactions/[^/]+$ |
          POST ^/v1/leads$ | GET ^/v1/leads$
     assertAgentAllowed(identity: Identity | undefined, agentId: string): void
        → no-op when identity is undefined or scope is "full"; otherwise throw
          new HttpError(403, "agent_not_allowed", "This key cannot use the requested agent.").
4. src/server/auth/apiKeys.ts —
   a. In resolveApiKeyIdentity, build both identities (DB path and env path) with
      { ...scopeForSubject(subject), subject, clientId, mode: "remote" }.
   b. In the installApiKeyAuth hook, after request.identity is set:
        if (request.identity.scope === "public" &&
            !isPublicRouteAllowed(request.method, request.url.split("?")[0] ?? "")) {
          throw forbidden("This key is not permitted to call this endpoint.");
        }
      (forbidden comes from ../errors.js.)
5. src/server/routes/runs.ts —
   a. POST /v1/runs: immediately after parsing the body and BEFORE deps.registry.get:
        const identity = request.identity;
        if (identity?.scope === "public") {
          assertAgentAllowed(identity, body.agentId);
          if (body.autonomy !== undefined && body.autonomy !== "gated")
            throw new HttpError(403, "autonomy_not_allowed", "This key cannot change run autonomy.");
          if (body.modelId !== undefined)
            throw new HttpError(403, "model_pin_not_allowed", "This key cannot select a model.");
        }
   b. In loadScopedProject (top of the file), after assertProjectAccess add
        assertAgentAllowed(request.identity, project.agentId);
      so GET/advance on a run of a non-public agent is refused even if the id is known.
6. src/server/routes/interactions.ts — in both handlers, directly after assertProjectAccess(...), add
     assertAgentAllowed(request.identity, project.agentId);
7. .env.example — under the JANTRA_REMOTE_API_KEYS comment add:
     # Keys whose subject is listed here are PUBLIC: limited to JANTRA_PUBLIC_AGENT_IDS, cannot set
     # autonomy or modelId, and can only call run create/read/advance/interactions and leads.
     # JANTRA_PUBLIC_SUBJECTS=web
     # JANTRA_PUBLIC_AGENT_IDS=intake-public,firebnb-concierge
8. Regression "public-key-scope" in src/runtime/evals/regressions.ts. Build
     createServer({ mode: "remote", loopbackToken: "", store: new JsonProjectStore(),
                    apiKeys: [ { key: "pub-key", clientId: "t1", subject: "web" },
                               { key: "full-key", clientId: "t1", subject: "ops" } ] })
   with JANTRA_PROJECT_DIR / JANTRA_AUDIT_DIR already pointing at the eval temp dirs used by neighbouring
   checks (copy their setup). Assert with app.inject:
     - pub-key POST /v1/runs {agentId:"planning-pipeline"}                      → 403 code agent_not_allowed
     - pub-key POST /v1/runs {agentId:"intake-public", autonomy:"auto"}         → 403 autonomy_not_allowed
     - pub-key POST /v1/runs {agentId:"intake-public", modelId:"gemini-2.5-pro"}→ 403 model_pin_not_allowed
     - pub-key POST /v1/runs {agentId:"intake-public", title:"x"}               → 200, body.run.agentId intake-public
     - pub-key GET  /v1/runs                                                     → 403
     - pub-key POST /v1/complete {system:"s", user:"u"}                         → 403
     - pub-key GET  /v1/agents                                                   → 403
     - full-key POST /v1/runs {agentId:"planning-pipeline", title:"x"}          → 200; keep its run id
     - pub-key GET  /v1/runs/<that id>                                           → 403 agent_not_allowed
     - full-key GET /v1/agents                                                   → 200
   Close the app at the end. Register: await runRegression("public-key-scope", verifyPublicKeyScope).

INTERFACES & DATA CONTRACTS
- Identity as in step 2. Every place that constructs an Identity must set scope (TypeScript will flag misses).
- New error codes (HTTP 403): agent_not_allowed, autonomy_not_allowed, model_pin_not_allowed.
  Route-level refusal uses the existing code "forbidden".
- Env: JANTRA_PUBLIC_SUBJECTS, JANTRA_PUBLIC_AGENT_IDS as in step 1.

EDGE CASES
- request.url may contain a query string; always strip it before matching.
- Admin paths (/v1/admin/*) are skipped by the auth hook already; leave that untouched.
- Local mode: request.identity is undefined → all helpers are no-ops. Do not add identity in local mode.
- A DB-stored key with subject "web" is public too (same rule). That is intended.
- JANTRA_PUBLIC_SUBJECTS="" must disable the feature entirely (every key full) — this is the rollback switch.
- body.agentId has a schema default of "planning-pipeline"; a public key that omits agentId must get 403.

NON-GOALS
- No database schema change (a `scope` column comes in T-015).
- Do not modify deploy/cloudflare-worker/, web/, packages/, the orchestrator, or createRunBodySchema.
- Do not add budgets for other agents (T-006/T-012).

ACCEPTANCE CRITERIA
1. npx tsc -p tsconfig.json --noEmit exits 0.
2. npm run eval exits 0 and prints the public-key-scope check as passed; all earlier checks still pass.
3. npm run server:smoke and npm run smoke exit 0.
4. No Identity object literal in src/ lacks `scope`.

VERIFICATION
  npx tsc -p tsconfig.json --noEmit
  npm run eval
  npm run smoke
  npm run server:smoke
If server:smoke uses a key whose subject is "web" and now fails with 403, change the smoke test's key subject
to "ops" (do not loosen the rule) and say so under DEVIATIONS.

RISK & ROLLBACK
- Risk: a live site using a subject-"web" key for a non-allowlisted agent starts getting 403.
- Rollback without code: set JANTRA_PUBLIC_SUBJECTS= (empty) or widen JANTRA_PUBLIC_AGENT_IDS.
- Code rollback: revert the commit; no data migration involved.

ESCALATION CONDITIONS — stop and report if:
- Any other code path constructs request.identity that you cannot make set `scope` without guessing.
- createServer cannot be built in-process with env-style apiKeys as described.
- More than the listed files need changes to make the typecheck pass.

Finish with the report format from 07_AGENT_CONTEXT.md.
```

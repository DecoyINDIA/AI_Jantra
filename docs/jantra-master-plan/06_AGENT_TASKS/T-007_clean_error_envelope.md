# TASK ID: T-007

**Title:** Clean error envelope
**Priority:** P1
**Objective:** No 5xx response contains internal error text; unknown agent ids return 404; every 5xx is logged server-side with a request id.
**Why This Matters:** `sendHttpError` returns raw exception messages (paths, SQL, provider output) to callers, including anonymous widget users (Audit A-10).
**Prerequisites:** none.
**Effort & Complexity:** Small; low reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-007 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/server/errors.ts: sendHttpError(reply, err) handles CostCeilingExceededError (429), GateConflictError
  (409), HttpError (its status); everything else → 500 { error: { code: "internal_error", message: <err.message> } }.
- src/server/app.ts: app.setErrorHandler((err, _request, reply) => { sendHttpError(reply, err); });
- src/runtime/errors.ts defines StageFailedClosedError and SchemaValidationError (check exact names and
  whether they carry `code`/`details`).
- src/server/routes/runs.ts line 52: deps.registry.get(body.agentId) throws a plain Error for unknown ids.
- src/agents/registry.ts: AgentRegistry.get throws Error(`Agent definition ${agentId} was not found.`).
- Fastify itself raises errors with a numeric statusCode for malformed JSON, payload too large, etc.

FILES TO MODIFY
- src/server/errors.ts, src/server/app.ts, src/server/routes/runs.ts, src/server/smoke.ts (add assertions),
  src/runtime/evals/regressions.ts

IMPLEMENTATION STEPS
1. errors.ts — change the signature to sendHttpError(reply, err, requestId?: string) and add branches, in
   this order after the existing three:
   a. StageFailedClosedError → 422 { code: "stage_failed_closed",
        message: "The stage stopped because its output could not be verified.", details: { requestId } }.
      Do not include err.message or err.details (they can contain model output).
   b. Errors that have a numeric `statusCode` between 400 and 499 (Fastify client errors) →
        that status, { code: "bad_request", message: "Request could not be processed." }.
   c. Everything else → 500 { code: "internal_error", message: "Internal error.", details: { requestId } }.
2. app.ts — error handler becomes:
     app.setErrorHandler((err, request, reply) => {
       const status = (err as { statusCode?: number }).statusCode;
       const isClient = err instanceof HttpError || err instanceof GateConflictError ||
                        err instanceof CostCeilingExceededError || (typeof status === "number" && status < 500);
       if (!isClient) {
         console.error(JSON.stringify({ level: "error", requestId: request.id, method: request.method,
           path: request.url.split("?")[0], error: err instanceof Error ? err.message : String(err),
           stack: err instanceof Error ? err.stack : undefined }));
       }
       sendHttpError(reply, err, request.id);
     });
   Import the needed classes. Never log request bodies or headers.
3. runs.ts — replace `const definition = deps.registry.get(body.agentId);` with a try/catch that throws
   notFound(`Agent ${body.agentId} was not found.`) (same pattern as src/server/routes/agents.ts).
4. smoke.ts — add two assertions using the existing request helper in that file:
   POST /v1/runs {agentId:"does-not-exist"} → 404 code not_found;
   a malformed JSON body to POST /v1/runs → 400 and the body does not contain "Unexpected token" or "at ".
5. Regression "error-envelope-no-leak": build a server with a store stub whose loadProject throws
   new Error("SECRET /data/jantra/x.sqlite"); GET /v1/runs/abc → 500, body.error.message === "Internal error.",
   body JSON does not contain "SECRET", details.requestId is a non-empty string.

EDGE CASES
- Keep 429 and 409 behaviours byte-for-byte (the widget depends on their codes).
- The SSE route hijacks the reply; errors thrown before hijack follow the same handler — no special case.

NON-GOALS: no logging library; no change to HttpError messages thrown deliberately by routes.

ACCEPTANCE CRITERIA
1. `grep -n "message," src/server/errors.ts` shows no path that returns err.message for non-HttpError,
   non-Gate, non-Cost errors.
2. npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0.

RISK & ROLLBACK: operators lose error text in responses; it is now in stderr with the request id. Revert to roll back.

ESCALATION CONDITIONS — stop and report if web/ or packages/embed-widget parse `error.message` of 500
responses for behaviour (search for "internal_error" and ".message" in those folders before finishing; report,
do not edit them).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

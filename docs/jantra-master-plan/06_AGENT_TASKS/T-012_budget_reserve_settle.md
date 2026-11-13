# TASK ID: T-012

**Title:** Budget reserve/settle and unknown-price guard
**Priority:** P1
**Objective:** Concurrent gateway calls cannot overshoot the daily ceiling by more than one reservation, and the server refuses to run paid models when it has no way to know their cost.
**Why This Matters:** `/v1/complete` checks the budget, calls the model, then records spend, so parallel requests all pass; and with no configured price and no `usage.cost` every ceiling compares against $0 (Audit A-07).
**Prerequisites:** none.
**Effort & Complexity:** Medium; moderate reasoning.
**Recommended Agent Tier:** Medium-capability agent.

---

## Standalone Execution Prompt

```
You are implementing task T-012 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/server/routes/complete.ts POST /v1/complete: clientDailyGatewayBudgetStatus(store, clientId) → if
  exceeded 429; provider.generate(...); recordGatewaySpend(store, clientId, result.costUsd); then only an
  audit record if result.costUsd > config.gatewayRunCeilingUsd (default 0.05).
- src/runtime/gatewayBudget.ts: clientDailyGatewayBudgetStatus, recordGatewaySpend, intakeBudgetDayUtc import.
- ProjectStore (src/pipeline/store.ts) has getClientDailyGatewaySpend(clientId, day) and
  addClientDailyGatewaySpend(clientId, day, deltaUsd). Implementations: JsonProjectStore (file
  read-modify-write, synchronous) and SqliteProjectStore (upsert `usd = usd + excluded.usd`).
  NOTE: both implementations are synchronous and Node is single-threaded, so a synchronous
  check-and-add cannot be interleaved. The race exists only because the model call sits between check and add.
- src/config.ts requireApiKey(): for provider "openai-compatible" it only console.warns when
  JANTRA_PRICE_INPUT and JANTRA_PRICE_OUTPUT are both 0.
- src/model/openaiCompatible.ts computes costUsd from usage.cost when the endpoint returns it, else from the
  configured prices. Open the file and find where costUsd is computed before editing.

FILES TO MODIFY
- src/runtime/gatewayBudget.ts, src/server/routes/complete.ts, src/config.ts, src/model/openaiCompatible.ts,
  src/runtime/evals/regressions.ts, .env.example

IMPLEMENTATION STEPS
1. gatewayBudget.ts — add:
     export function reserveGatewayBudget(store, clientId, estimateUsd, now = new Date()):
       { ok: boolean; spend: number; ceiling: number; day: string }
       → day = intakeBudgetDayUtc(now); ceiling = config.gatewayClientDailyCeilingUsd;
         spend = store.getClientDailyGatewaySpend(clientId, day);
         if (ceiling > 0 && spend + estimateUsd > ceiling) return { ok: false, … };
         if (estimateUsd > 0) store.addClientDailyGatewaySpend(clientId, day, roundUsd(estimateUsd));
         return { ok: true, … };   // synchronous: no await between read and add
     export function settleGatewayBudget(store, clientId, estimateUsd, actualUsd, day: string): void
       → delta = roundUsd(actualUsd - estimateUsd); if (delta !== 0) store.addClientDailyGatewaySpend(clientId, day, delta);
   Negative deltas must be supported: check both store implementations accept a negative delta (they add);
   recordGatewaySpend's `deltaUsd <= 0` early return must not be reused for settle.
2. complete.ts — replace the status check and the later recordGatewaySpend call:
     const estimate = config.gatewayRunCeilingUsd;
     const reservation = reserveGatewayBudget(store, clientId, estimate);
     if (!reservation.ok) { audit as today; return 429 with the same body as today }
     let result;
     try { result = await provider.generate({...}); }
     catch (err) { settleGatewayBudget(store, clientId, estimate, 0, reservation.day); throw err; }
     settleGatewayBudget(store, clientId, estimate, result.costUsd, reservation.day);
   Keep everything else (audit records, response shape) unchanged.
3. Unknown price guard:
   a. config.ts: add allowUnpricedModels: booleanFromEnv("JANTRA_ALLOW_UNPRICED_MODELS", false).
   b. openaiCompatible.ts: where costUsd is derived — if the response carries no usable usage.cost AND both
      configured prices are 0 AND !config.allowUnpricedModels AND total tokens > 0, throw a new
      typed error UnknownModelCostError (add to src/runtime/errors.ts, extending Error with code
      "unknown_model_cost") with message "Model cost is unknown: set JANTRA_PRICE_INPUT/JANTRA_PRICE_OUTPUT
      or JANTRA_ALLOW_UNPRICED_MODELS=true.".
   c. src/server/errors.ts sendHttpError: map UnknownModelCostError → 503 { code: "unknown_model_cost",
      message: "The model's cost is not configured." }.
   d. Keep the start-up console.warn in requireApiKey.
4. .env.example: document JANTRA_ALLOW_UNPRICED_MODELS (default false; set true only for free local models
   such as Ollama).
5. Regressions:
   - "gateway-reserve-settle": temp JsonProjectStore; ceiling from config (2.0) and estimate 0.05:
       seed spend 1.96 → reserve(0.05) → ok false; seed 1.90 → reserve ok, stored spend 1.95;
       settle(estimate 0.05, actual 0.01) → stored 1.91; settle(0.05, 0) after a fresh reserve → net 0 change.
     Then simulate concurrency: call reserve 50 times synchronously from spend 0 with estimate 0.05 → exactly
     40 succeed (ceiling 2.0); assert stored spend ≤ 2.0.
     Read config values at runtime rather than hard-coding 2.0/0.05 so env overrides do not break the test.
   - "unknown-model-cost": unit-test the decision as a pure exported function
       shouldRejectUnknownCost({ reportedCost, priceIn, priceOut, allowUnpriced, totalTokens }): boolean
     and assert its truth table (reported cost present → false; prices set → false; allow flag → false;
     zero tokens → false; otherwise true). Use it in step 3b.

EDGE CASES
- OpenRouter returning usage.cost = 0 for a genuinely free model: treat "cost field present" as known cost
  (even when 0) — the guard looks at presence, not value.
- Floating point: keep roundUsd (6 decimals) on every add.
- Do not change intake budget logic in this task.

NON-GOALS: no per-key budgets, no SQLite transaction work (unnecessary while the store is synchronous), no
changes to the Gemini provider's pricing.

ACCEPTANCE CRITERIA: npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke
exit 0; both regressions pass; the existing "gateway-daily-budget" regression still passes (adapt it only if
it calls a function you removed, and say so).

RISK & ROLLBACK: a deployment using an OpenAI-compatible endpoint without prices or usage.cost will start
returning 503 until configured — intended; JANTRA_ALLOW_UNPRICED_MODELS=true restores old behaviour. Revert to roll back.

ESCALATION CONDITIONS — stop and report if openaiCompatible.ts has no single place where cost is derived, or
if the mock provider path would hit the new guard.

Finish with the report format from 07_AGENT_CONTEXT.md.
```

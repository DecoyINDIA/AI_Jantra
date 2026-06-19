# The four runner shapes

Every Jantra stage is one of four shapes. Pick the closest match; don't invent a fifth without a written reason. Each skeleton below is condensed from the real runner — names and control flow are faithful. Read the cited file before copying.

A runner is `(ctx: StageContext) => Promise<Artifact[]>` for `interactionMode: "none"`, or a `ReentrantStageRunner` (`start` / `resume` returning `StageRunStep`) for `interactionMode: "reentrant"`.

```ts
// src/pipeline/reentrant.ts — the reentrant return type. Note: NO "success" variant.
type StageRunStep =
  | { status: "awaiting_input";        state: PersistedStageState; interaction: PendingInteraction }
  | { status: "awaiting_confirmation"; state: PersistedStageState; artifacts: Artifact[] }
  | { status: "failed";                state: PersistedStageState; error: StageFailedClosedError };
```
Successful completion is `awaiting_confirmation` with artifacts — the human gate is the success path. A runner either throws `StageFailedClosedError` (the orchestrator records the failure) or returns the `failed` variant; both are valid, pick one and be consistent.

---

## A. Conversation — reentrant interview → structured summary

**When:** interview the user, converge on a schema-validated summary a critic accepts. **Canonical:** `src/pipeline/stages/intake.ts`. **Mode:** `reentrant`. **Register in both** `RUNNERS` and `REENTRANT_RUNNERS`.

```ts
async resume(ctx, response) {
  // 1. Idempotency guard — the open interaction must match the answer.
  if (state.pendingInteractionId !== response.interactionId) throw new StageFailedClosedError(...);
  state.pendingInteractionId = undefined;          // clear AFTER the match validates, never before
  state.messages.push({ role: "user", content: answer });
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return continueIntake(ctx, state);
}

async function continueIntake(ctx, state) {
  while (state.step < config.maxSteps) {
    state.step++;
    const result = await ctx.provider.generate({ purpose: "generator", system: SYSTEM_PROMPT,
      messages: state.messages, tools: [submitTool], thinking: true, maxOutputTokens: ... });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);   // audit every call
    recordIntakeSpend(ctx.store, ctx.project, ctx.stageId, result.costUsd);
    enforceIntakeRunCeiling(ctx.audit, ctx.project, ctx.stageId);                     // cost ceiling
    state.messages.push(result.message);

    const submit = result.toolCalls.find((c) => c.name === "submit_idea_summary");
    if (submit) {
      const outcome = await evaluateSubmission(ctx, submit.args, roundsUsed);        // schema + critic
      if (outcome.kind === "followups") return awaitingQuestion(ctx, state, outcome.questions);
      if (outcome.kind === "fail")      throw new StageFailedClosedError("...", { eval: outcome.eval });
      return { status: "awaiting_confirmation", state, artifacts: [summaryArtifact(...)] };
    }
    // No tool call yet → the model asked a question; surface it and wait.
    return awaitingQuestion(ctx, state, result.text.trim());
  }
  throw new StageFailedClosedError("Intake hit the step cap without a valid summary.");
}
```

**Distinguishing idiom — critic-driven round bounding.** `evaluateSubmission` combines *deterministic* follow-ups (gaps a schema can't express) with the *critic's* follow-ups, slices to 2, and `MAX_FOLLOWUP_ROUNDS = 2` caps the exchanges. When the budget is spent, fail closed — do not lower the bar to exit the loop. Honest gaps go into the summary's `open_questions`; the critic is explicitly told not to penalize them.

**Gotchas:** clear `pendingInteractionId` only after the id-match check (early clear deadlocks resume); the runner owns incrementing `state.step`; persist `messages` + `data` every turn so resume survives a restart.

---

## B. Research — grounded search + per-claim citation verification

**When:** the artifact states external facts that must each resolve to a retrieved source. **Canonical:** `src/pipeline/stages/research.ts`. **Mode:** `none`.

```ts
const plan = await planResearch(ctx, idea);                       // 2-4 queries/section, temperature: 0
const hits = await Promise.all(sections.map((s) =>
  groundedSearch(ctx, s, { grounding: true, cacheKey: `${ctx.project.id}:idea_summary:v${idea.version}` })));
const section = await synthesizeSection(ctx, ...);                // claims, each tagged with source citations
const claims  = await verifyClaims(ctx, claims, sourceTexts);    // verified:true ONLY if quote-matched to source
// critic applies a deterministic floor the LLM cannot override:
//   citationAccuracy = verifiedCount > 0 ? 5 : 2;   // 2 fails the 4+ rubric
const evaluated = await runEvaluatorLoop({ generate, critique: critiqueReport, refine, rubric, maxRounds });
const outputCheck = runArtifactOutputChecks(artifact, ctx.project.claims);   // blocks verified_claim_without_quote
if (!outputCheck.allowed || !evaluated.eval.passed)
  throw new StageFailedClosedError("Research report did not pass verification.", { eval: evaluated.eval, outputCheck });
```

**Distinguishing idiom — deterministic critic floor.** Citation accuracy is *code*, not model opinion: zero verified claims hard-caps the score below the pass threshold, so unquoted assertions can never pass. This is the playbook's "verification beats generation" made structural. Untrusted fetched content is fenced via `sanitizeUntrustedWebContent` before it enters any prompt.

**Gotchas:** the grounded-search `cacheKey` is keyed on `idea_summary` version — a reject-and-rerun bumps the version, busts the cache, and re-runs every search (cost multiplier, budget for it). `verifyClaims` is binary: no quote, or quote not found in source → `verified: false`.

---

## C. Transform — prior artifacts in, new artifact out (single shot or tournament)

**When:** synthesize prior-stage artifacts into a new one; no user interaction. **Canonical:** `src/pipeline/stages/planning.ts` (PRD/TRD/build_plan). **Mode:** `none`.

Simplest form is one generator/critic pass via `runEvaluatorLoop`. The high-stakes form is the **tournament**:

```ts
const framings = ["conservative", "balanced", "ambitious"];
const variants = await Promise.all(framings.map(async (f) => ({
  f, doc: await generateDocument(ctx, kind, ..., f), critique: await critiqueDocument(ctx, kind, doc) })));
let winner = selectBest(variants);                               // first-to-pass, else highest score
if (!winner.critique.eval.passed) { /* refine once; if still failing → StageFailedClosedError */ }
const synthesized = await synthesizeWinningDocument(winner, losers);   // graft 2-3 strong loser elements
const sc = await critiqueDocument(ctx, kind, synthesized);
if (!sc.eval.passed || score(synthesized) < score(winner))
  return { doc: winner.doc, eval: winner.critique.eval };       // regression guard: discard, keep winner
// cross-document consistency must preserve every PRD requirementId:
if (!checkCrossDocumentConsistency(prd, trd, plan).passed) throw new StageFailedClosedError("...", { issues });
```

**Distinguishing idiom — synthesis with a regression guard.** Generating N candidates from genuinely different angles catches blind spots a single draft misses; the merge step is *always* re-critiqued and discarded if it scores worse than the validated winner. Use the tournament only where the solution space is wide (planning); a single `runEvaluatorLoop` pass is right for most transforms.

**Gotchas:** synthesis can introduce conflicts no per-variant critic ever saw — never ship it unchecked. Preserve all PRD `requirementId`s through refine/synthesize or consistency fails closed.

---

## D. Tool-loop — bounded tool use with approval gates

**When:** the agent issues tool calls to act on the world, each gated by policy. **Canonical:** `src/agents/support/` (`index.ts`, `reentrant.ts`, `tools.ts`). **Mode:** `reentrant` (it pauses for human approval). Stage declares `kind: "tool-loop"` and `toolNames`.

```ts
async function continueSupport(ctx, state, policy) {
  while (state.step < config.maxSteps) {
    state.step++;
    const result = await ctx.provider.generate({ ..., tools: allowedTools });
    if (!result.toolCalls.length) return completeSupport(ctx, state);   // no tools → done
    const pending = await processToolCalls(ctx, state, policy, result.toolCalls);
    if (pending) return pending;                                        // awaiting_approval
  }
  throw new StageFailedClosedError("Support agent hit the step cap without completion.");
}

async function processToolCalls(ctx, state, policy, calls) {
  for (const call of calls) {
    const verdict = policy.decide(tool, call.args);          // { allow | ask | deny }
    if (verdict.decision === "deny")  results.push(errorPart(call, verdict.reason));
    else if (verdict.decision === "ask")
      return awaitingApproval(ctx, state, call, verdict.reason, results, /* remaining */);  // persist remaining!
    else results.push(await executeAllowedTool(ctx, state, call));
  }
  state.messages.push({ role: "user", content: results });   // feed tool results back as function responses
}
```

**Distinguishing idiom — per-call policy verdict.** `RuleBasedPolicy.decide` evaluates `denyTools → denyWhen → alwaysAsk → byRisk`, first match wins. `ask` pauses the loop for a human approval interaction; the **remaining, not-yet-run calls must be persisted to `state.data`** so they resume after approval, or they're silently lost. Irreversible tools must be `ask` (or `deny`); read-only tools are `allow`. `escalate_to_human` sets `handoff=true`, skips remaining calls, and is intentionally *not* policy-gated.

**Gotchas:** save `remainingToolCalls` before returning the approval step; on `resume`, validate the approved call matches the pending one, execute (or error if rejected), then continue the loop.

---

## Choosing between them

| If the stage… | Use shape |
|---|---|
| talks back and forth with a person to pin down intent | A. Conversation |
| asserts facts that need external sources | B. Research |
| turns prior artifacts into a new document, no user | C. Transform |
| takes actions in the world via tools needing approval | D. Tool-loop |

If none fit, you may need a richer single stage or two agents — re-read SOP Phase 2 (decomposition) before writing a novel shape. A genuinely new shape is the moment to involve a human reviewer, not to improvise.

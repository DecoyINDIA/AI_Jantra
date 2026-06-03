# Jantra AI Implementation Plan

Status: planning only. This document is the only file produced in this step. No application code should be changed until this plan is reviewed and approved.

## 1. Current State Summary

### Binding product direction

Jantra AI is a reusable agent runtime plus a three-stage planning pipeline:

1. Intake
2. Research
3. Planning

Stage 4, Build, remains registered but disabled. The product quality bar is grounding, verification, auditability, fail-closed behavior, and human gates between stages. `docs/BUILD_SPEC.md` is the source of truth and its milestone order in section 13 must be followed.

### Existing runtime

The runtime is compact and mostly hand-written:

- `src/agent.ts` is a manual agent loop using `@anthropic-ai/sdk` directly. It sends Anthropic tools, reads thinking/text/tool-use blocks, gates each tool call through `policy.ts`, executes approved tools, records JSONL audit entries, and stops on handoff.
- `src/types.ts` defines `ToolDef`, `ToolContext`, `Policy`, `AgentSpec`, approval and handoff handlers, and `RunResult`. These are vendor-neutral in spirit, but some usage fields are Claude-specific.
- `src/config.ts` defaults to `claude-opus-4-8`, reads `ANTHROPIC_API_KEY`, and exposes Claude-style `effort`.
- `src/audit.ts` writes synchronous append-only JSONL entries. It currently has events for run start/end, thinking, messages, tool calls, policy decisions, approvals, handoff, model usage, and errors.
- `src/policy.ts` is a synchronous rule-based gate for tool risk: read is allowed, write and sensitive ask by default.
- `src/handoff.ts` is a console sink.
- `src/agents/support/*` is the reference support agent using the generic runtime tool surface.

What must change:

- Remove all runtime dependence on Anthropic after Milestone 1.
- Introduce `src/model/provider.ts` and route every model call through it.
- Keep the manual tool loop because policy gating and auditability are product-critical.
- Update config, usage, cost, thinking summaries, prompt caching assumptions, and model call audit events for Gemini.
- Preserve fail-closed approval behavior and the support reference agent, but port it to the provider interface.

### Existing pipeline

The pipeline foundation exists but is early:

- `src/pipeline/types.ts` defines `StageId`, `StageStatus`, `Artifact`, `StageState`, `Project`, `StageIO`, `StageContext`, and `StageRunner`. `StageContext` currently carries an Anthropic client.
- `src/pipeline/store.ts` persists JSON project records and Markdown artifacts under `.jantra/projects/<clientId>/`.
- `src/pipeline/orchestrator.ts` creates projects, runs the current stage, writes artifacts, sets `awaiting_confirmation`, and has `confirmStage`.
- `src/pipeline/cli.ts` runs Stage 1 only and stops at the first gate.
- `src/pipeline/stages/intake.ts` is a direct Anthropic multi-turn intake loop with a `submit_idea_summary` tool.
- Research and Planning are unimplemented. Build is unimplemented and should remain disabled.

What must change:

- Replace the Anthropic client in `StageContext` with a `ModelProvider` or stage-scoped provider factory.
- Port Intake to Gemini and add a critic pass before accepting the idea summary.
- Extend project data with sources, claims, eval scores, and cost rollup.
- Add Research and Planning stages only after the Gemini provider and runtime evaluator are in place.
- Keep the human confirmation gate abstract and CLI-backed for now.

## 2. Verified Gemini Facts

Verified against official Google docs and the official Google Gen AI TypeScript SDK during this planning pass.

### SDK and import surface

- Official SDK: `@google/genai`. Google recommends the Google GenAI SDKs as official, production-ready libraries, and lists JavaScript/TypeScript install as `npm install @google/genai`: https://ai.google.dev/gemini-api/docs/libraries
- Official JS/TS SDK repo: https://github.com/googleapis/js-genai
- Current latest SDK version observed: `2.7.0`. GitHub shows release `v2.7.0` on May 28, 2026, and `npm.cmd view @google/genai version` returned `2.7.0`: https://github.com/googleapis/js-genai
- Import surface: `import { GoogleGenAI } from "@google/genai";`, then `new GoogleGenAI({ apiKey })`, then `ai.models.generateContent(...)`: https://googleapis.github.io/js-genai/release_docs/classes/client.GoogleGenAI.html
- The spec uses `GEMINI_API_KEY`. The SDK can use that safely by passing it explicitly as `apiKey: process.env.GEMINI_API_KEY`. The SDK's implicit environment variable path also documents `GOOGLE_API_KEY`, so Jantra should not rely on implicit env lookup.

### Model IDs and capabilities

- Gemini 2.5 Flash model code is `gemini-2.5-flash`: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
- Gemini 2.5 Pro model code is `gemini-2.5-pro`: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro
- Both models support function calling, Search grounding, structured outputs, thinking, caching, URL context, and a 1,048,576 token input limit with a 65,536 output token limit according to their model pages.
- Flash-Lite exists, but it is outside the Jantra spec and should not be exposed as a pipeline option.

### Function calling

- Function declarations are passed under `config.tools`, using objects shaped like `{ functionDeclarations: [...] }`.
- Function declarations use `name`, `description`, and `parameters` in a JSON-schema-like object. JavaScript examples import `Type` from `@google/genai`.
- Function calls are read from `response.functionCalls`.
- Tool results are returned in the next request as content parts with `functionResponse` containing `id`, `name`, and `response`.
- Function calling modes are configured with `toolConfig.functionCallingConfig.mode`; documented modes include `AUTO`, `ANY`, `NONE`, and preview `VALIDATED`: https://ai.google.dev/gemini-api/docs/function-calling
- Jantra should continue manual function execution. Do not use automatic function calling for risky tools because every tool call must pass policy, approval, audit, and handoff logic.

### Structured output / JSON mode

- Gemini 2.5 Flash and Gemini 2.5 Pro support structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Current docs show JavaScript structured output using `config.responseFormat: { text: { mimeType: "application/json", schema } }`, often with Zod plus `zod-to-json-schema`.
- Older examples and some snippets use `responseMimeType` and `responseJsonSchema`. Implementation should follow the installed `@google/genai@2.7.0` TypeScript types and compile against them, with a small adapter in `gemini.ts` so the rest of the runtime never sees SDK-specific field names.
- Structured output gives syntactic/schema shape, not semantic truth. Every model JSON result still needs Zod validation and domain validation.

Important Gemini 2.5 constraint:

- Google documents "Structured outputs with tools" as available only to Gemini 3 series models, not Gemini 2.5: https://ai.google.dev/gemini-api/docs/structured-output
- Google also documents "Function calling with Structured output" as Gemini 3 series only: https://ai.google.dev/gemini-api/docs/function-calling
- Therefore Jantra must not assume a single Gemini 2.5 call can combine Search grounding, custom function tools, and structured output. The provider should reject unsupported combinations or split the work into separate calls.

### Google Search grounding

- Current models use the `google_search` tool. In JavaScript, this is represented as `{ googleSearch: {} }` in `config.tools`: https://ai.google.dev/gemini-api/docs/google-search
- Gemini 2.5 Pro and Gemini 2.5 Flash both support Grounding with Google Search.
- Grounding metadata is returned as `response.candidates[0].groundingMetadata`, including `webSearchQueries`, `groundingChunks`, and `groundingSupports`.
- `groundingChunks` include source `uri` and `title`. `groundingSupports` map text segments to grounding chunk indices, which can be turned into inline citations.
- For Gemini 2.5 and older models, Search grounding is billed per prompt, not per individual query. Gemini 3 uses per-search-query billing.
- Google documents built-in tool plus custom function calling combinations as Gemini 3-only. For Gemini 2.5 Research, use separate calls: grounded search calls first, then explicit fetch and deterministic registry verification, then structured synthesis calls without Search grounding.

### Thinking and reasoning exposure

- Gemini 2.5 models use `thinkingConfig.thinkingBudget`; dynamic thinking can be requested with `-1`, and docs show `0` as turning thinking off in the Flash example: https://ai.google.dev/gemini-api/docs/thinking
- Thought summaries are enabled with `thinkingConfig.includeThoughts: true`.
- The SDK returns thought summary parts where `part.thought` is true. Jantra can audit these summaries, not hidden raw chain-of-thought.
- When thinking is enabled with function calling, Gemini 2.5 can return thought signatures. The SDK handles signatures automatically if full response parts are preserved in conversation history. Do not flatten or concatenate signed parts in the manual loop.
- Usage metadata includes `thoughtsTokenCount`; thinking tokens are charged as output tokens.

### Context caching

- Gemini offers implicit caching by default for Gemini 2.5 and newer models, but without a guaranteed cost saving.
- Current docs list the implicit caching minimum input token limit as 2,048 tokens for both Gemini 2.5 Flash and Gemini 2.5 Pro. This differs from older directional numbers in some snippets/spec notes.
- Explicit caching is available through `ai.caches.create(...)`, then `config.cachedContent: cache.name` on `generateContent`: https://ai.google.dev/gemini-api/docs/caching
- Explicit caching has storage cost and default TTL behavior. Use it only for large stable prefixes or long research/planning contexts where the economics are clearly positive.

### Usage and pricing

- SDK `usageMetadata` includes fields such as `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`, and `totalTokenCount`: https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponseUsageMetadata.html
- Standard paid-tier Gemini 2.5 Flash pricing: input $0.30 per 1M text/image/video tokens, output $2.50 per 1M tokens including thinking, context cache $0.03 per 1M text/image/video tokens, storage $1.00 per 1M tokens per hour. Search grounding: free tier up to 500 RPD; paid tier 1,500 RPD free shared with Flash-Lite, then $35 per 1,000 grounded prompts: https://ai.google.dev/gemini-api/docs/pricing
- Standard paid-tier Gemini 2.5 Pro pricing: input $1.25 per 1M tokens for prompts <= 200k tokens and $2.50 over 200k, output $10.00 per 1M tokens for prompts <= 200k and $15.00 over 200k, context cache $0.125 per 1M tokens for prompts <= 200k and $0.25 over 200k, storage $4.50 per 1M tokens per hour. Search grounding: 1,500 RPD free, then $35 per 1,000 grounded prompts: https://ai.google.dev/gemini-api/docs/pricing
- Cost rollup should count cached content tokens separately, include thoughts tokens in output cost, and add Search grounding surcharge when applicable.

## 3. Per-Milestone Plan

### Milestone 1: Gemini Model Layer

Goal: replace direct Anthropic calls with a Gemini-only provider layer while keeping the runtime and Intake usable.

Files to create:

- `src/model/provider.ts`
- `src/model/gemini.ts`
- `src/model/index.ts`

Files to change:

- `package.json` and `package-lock.json`: remove `@anthropic-ai/sdk`; add `@google/genai`, `zod`, and likely `zod-to-json-schema`.
- `.env.example`: replace `ANTHROPIC_API_KEY` with `GEMINI_API_KEY`; add per-stage model env vars.
- `src/config.ts`: replace Claude model/effort config with Gemini stage model config, API key check, token limits, and early cost ceiling placeholders.
- `src/types.ts`: make runtime model usage fields provider-neutral.
- `src/agent.ts`: port the manual loop to `ModelProvider`, preserving policy, approvals, handoff, and audit.
- `src/cli.ts`: create the provider/factory instead of `new Anthropic()`.
- `src/pipeline/types.ts`: replace Anthropic client in `StageContext` with `ModelProvider` or stage provider factory.
- `src/pipeline/orchestrator.ts` and `src/pipeline/cli.ts`: resolve a provider per current stage.
- `src/pipeline/stages/intake.ts`: port to provider, preserve `submit_idea_summary`, validate output with Zod, and add a narrow intake critic pass.
- `src/agents/support/index.ts` and tools as needed: no vendor imports should remain.
- `README.md`: update only after implementation changes are approved and made.

Key types/functions:

- `ModelProvider.generate(opts: GenerateOptions): Promise<ModelResult>`
- `ModelMessage` with Gemini-compatible roles while hiding SDK details.
- `ToolSpec`, `ToolCall`, `ToolResultPart`, and mapping helpers from existing `ToolDef`.
- `GroundingCitation` or `GroundingSourceRef` that captures Gemini grounding metadata without pretending it is a verified source registry entry.
- `GeminiModelId = "gemini-2.5-flash" | "gemini-2.5-pro"`
- `getProviderForStage(stageId, config): ModelProvider`
- `calculateGeminiCost(modelId, usage, options): number`
- `extractThoughtSummary(response): string | undefined`
- `extractToolCalls(response): ToolCall[]`
- `toGeminiContents(messages): Content[]`
- `toFunctionDeclarations(tools): functionDeclarations[]`
- `assertGeminiCombinationSupported(opts)`: reject Gemini 2.5 calls that try to combine Search grounding, function calling, and structured output in unsupported ways.

Implementation notes:

- Keep the agent loop manual. The provider returns tool calls, but the runtime decides whether and how to execute them.
- Preserve full Gemini response content parts in conversation history so thought signatures remain intact.
- For structured outputs, parse provider text as JSON and validate with Zod before returning stage artifacts.
- The intake critic can be a simple separate model call in Milestone 1, then be extracted into `runtime/evaluator.ts` in Milestone 2. This keeps the hard rule "generator != critic" without jumping ahead to the generic evaluator.
- Model calls should audit `model_call` or, if event expansion lands in Milestone 2, at least continue `model_usage` with model id, tokens, thoughts tokens, cached tokens, and cost.

Tests/checks:

- `npm run typecheck`
- `rg -n "@anthropic-ai/sdk|Anthropic|claude|ANTHROPIC" src package.json .env.example README.md`
- `npm run support:auto` with `GEMINI_API_KEY` set
- `npm run pipeline` with `GEMINI_API_KEY` set, completing Intake to `awaiting_confirmation`
- Inspect audit JSONL for model id, token usage, cost, thinking summary where available, tool calls, policy decisions, and `clientId`

Acceptance criteria:

- No application code imports Anthropic.
- Intake runs end-to-end on Gemini 2.5 Flash by default.
- Support reference agent runs on Gemini through the provider interface.
- Per-stage model selection accepts only `flash` or `pro`.
- A real intake conversation produces a valid `idea_summary` artifact.
- The intake critic can reject or flag an underspecified summary.
- Typecheck is clean.

Definition-of-done checklist:

- [ ] `@google/genai` installed and Anthropic dependency removed.
- [ ] `GEMINI_API_KEY` required for runtime model calls.
- [ ] Provider interface hides all Gemini SDK types from stages.
- [ ] Intake and support agent use only the provider.
- [ ] Gemini usage, thoughts tokens, cached tokens, and cost are audited.
- [ ] Stage 4 remains disabled.
- [ ] `npm run typecheck` passes.

### Milestone 2: Runtime Services

Goal: add shared evaluator, telemetry, audit, and guardrail services so stages do not copy verification logic.

Files to create:

- `src/runtime/evaluator.ts`
- `src/runtime/telemetry.ts`
- `src/runtime/errors.ts` if typed errors need a home
- `src/runtime/rubrics.ts` or `src/runtime/evals/rubrics.ts` if rubrics are shared before Milestone 5

Files to change:

- `src/audit.ts`
- `src/policy.ts`
- `src/config.ts`
- `src/types.ts`
- `src/pipeline/types.ts`
- `src/pipeline/store.ts`
- `src/pipeline/stages/intake.ts`
- `src/model/gemini.ts`

Key types/functions:

- `EvalScore`
- `Rubric`
- `EvaluatorLoopOptions<TDraft, TArtifact>`
- `runEvaluatorLoop({ generate, critique, refine, rubric, maxRounds, budget })`
- `recordModelCall(audit, result, context)`
- `CostRollup`
- `CostTracker.addModelCall(stage, result)`
- `assertUnderCostCeiling(projectCost, config)`
- `GuardrailVerdict`
- `sanitizeUntrustedWebContent(content)`
- `detectPromptInjectionSignals(content)`
- `runArtifactOutputChecks(artifact, rubric, context)`
- Typed errors such as `ModelProviderError`, `SchemaValidationError`, `GuardrailBlockedError`, `CostCeilingExceededError`, `StageFailedClosedError`

Implementation notes:

- The evaluator loop should be provider-based and stage-agnostic. Stage-specific prompts and rubrics live with each stage or eval config.
- Critic calls must be separate calls with separate prompts. They can use the same Gemini family, but should be auditable as critic calls, not generator calls.
- Audit event expansion should include at least `model_call`, `eval_score`, `citation_verified`, `citation_rejected`, `guardrail_block`, `stage_gate`, and cost rollup updates.
- Output guardrails should stay small and deterministic where possible. Use model checks only for judgment-heavy checks and audit their reasoning summaries.
- Web content guardrails are prepared here, then used heavily in Milestone 3.

Tests/checks:

- `npm run typecheck`
- Unit-style checks for pure functions: cost calculation, cost ceiling, audit entry shape, prompt-injection signal detection, and evaluator pass/fail behavior.
- Run Intake and verify critic/eval score is stored and audited.
- Confirm a forced cost ceiling failure fails closed and creates handoff context.

Acceptance criteria:

- A stage can run generate -> critique -> refine and record an eval score.
- Model call usage and cost update a per-project rollup.
- Guardrail blocks are audited and fail closed.
- Intake uses the shared evaluator path or is ready to be migrated from the temporary Milestone 1 critic.

Definition-of-done checklist:

- [ ] `runtime/evaluator.ts` exists and is stage-agnostic.
- [ ] `runtime/telemetry.ts` produces per-stage and per-project rollups.
- [ ] New audit events are implemented.
- [ ] Output and untrusted-content guardrails exist.
- [ ] Typed errors are surfaced, audited, and not swallowed.
- [ ] Intake has a rubric, critic pass, and eval score.
- [ ] `npm run typecheck` passes.

### Milestone 3: Stage 2 Research

Goal: produce a cited market research report where every market claim resolves to a source that Jantra actually retrieved and registered.

Files to create:

- `src/pipeline/stages/research.ts`
- `src/pipeline/research/sourceRegistry.ts`
- `src/pipeline/research/citationVerifier.ts`
- `src/pipeline/research/webFetch.ts`
- `src/pipeline/research/schemas.ts`
- `src/pipeline/research/rubric.ts`

Files to change:

- `src/pipeline/types.ts`
- `src/pipeline/store.ts`
- `src/pipeline/orchestrator.ts`
- `src/pipeline/cli.ts`
- `src/policy.ts`
- `src/audit.ts`
- `src/config.ts`

Key types/functions:

- `Source`
- `Claim`
- `ResearchPlan`
- `ResearchSection`
- `ResearchFinding`
- `VerifiedCitation`
- `runResearch(ctx): Promise<Artifact[]>`
- `planResearchSections(ideaSummary)`
- `runGroundedSearch(section)` using Gemini Search grounding only
- `extractGroundingSources(response)`
- `fetchAndRegisterSource(url, metadata)`
- `hashContent(content)`
- `sanitizeFetchedContent(content)`
- `synthesizeSectionClaims(section, registeredSources)`
- `verifyCitations(claims, sourceRegistry)`
- `assembleResearchReport(sections, claims, sources, evalScore)`

Implementation notes:

- Because Gemini 2.5 should not combine Search grounding, custom function tools, and structured output in one call, Research should split the work:
  1. Grounded Gemini calls with `{ googleSearch: {} }` produce search-informed text and grounding metadata.
  2. The code extracts grounding URLs and explicitly fetches them.
  3. Fetched content is sanitized, hashed, and stored in the source registry.
  4. Separate structured synthesis calls produce claims that cite registry `sourceId`s.
  5. Deterministic verification rejects any claim whose citation does not resolve to a registered source.
- Google Search grounding metadata alone is not enough for Jantra's source registry, because the spec requires sources actually retrieved and content-hashed by Jantra.
- If a URL cannot be fetched, hashed, or registered, it cannot support a verified claim.
- Fetched pages are untrusted reference material only. Prompt-injection-like content is quoted or summarized as source material, never followed as an instruction.
- Source quality should be part deterministic and part critic-scored: prefer primary sources, recent official/company/market docs, reputable analyst/news sources, and competitor primary pages.
- The final report should include a sources appendix with registry IDs, URLs, titles, retrieval times, and content hashes.

Tests/checks:

- `npm run typecheck`
- Citation verifier rejects unknown source IDs.
- Citation verifier rejects claims with empty source IDs unless explicitly marked unverified.
- Source registry persists and reloads under `.jantra/projects/<clientId>/`.
- Web sanitizer flags obvious prompt injection strings such as "ignore previous instructions".
- A real idea run produces a sectioned report and every cited claim resolves to a registered source.
- Cost ceiling abort path is tested with a low ceiling.

Acceptance criteria:

- Research stage is registered and runs after confirmed Intake.
- Report has planned sections, balanced findings, risks, competitors, demand signals, and a source appendix.
- Every market claim has a verified citation or is explicitly marked unverified/abstained.
- Ungrounded drafts are rejected by deterministic verification and/or the critic.
- Human gate works after Research.

Definition-of-done checklist:

- [ ] `research.ts` implements plan -> search -> fetch/register -> synthesize -> verify -> critic/refine -> assemble.
- [ ] Source registry persists every retrieved source with `clientId`, URL, title, retrieval time, and content hash.
- [ ] Citation verification is deterministic.
- [ ] Prompt-injection handling is applied to fetched content.
- [ ] Research rubric and critic pass are active.
- [ ] Cost rollup includes Search grounding usage and model tokens.
- [ ] `npm run typecheck` passes.

### Milestone 4: Stage 3 Planning

Goal: turn confirmed Intake and Research artifacts into a coherent PRD, TRD, and build plan.

Files to create:

- `src/pipeline/stages/planning.ts`
- `src/pipeline/planning/schemas.ts`
- `src/pipeline/planning/rubric.ts`
- `src/pipeline/planning/consistency.ts`

Files to change:

- `src/pipeline/orchestrator.ts`
- `src/pipeline/types.ts`
- `src/pipeline/store.ts`
- `src/config.ts`
- `src/audit.ts`

Key types/functions:

- `PlanningInputs`
- `PrdDraft`
- `TrdDraft`
- `BuildPlanDraft`
- `PlanningDocumentKind = "prd" | "trd" | "build_plan"`
- `runPlanning(ctx): Promise<Artifact[]>`
- `generatePrd(inputs)`
- `generateTrd(prd, inputs)`
- `generateBuildPlan(prd, trd, inputs)`
- `critiquePlanningDocument(kind, draft, rubric)`
- `refinePlanningDocument(kind, draft, critique)`
- `checkCrossDocumentConsistency(prd, trd, buildPlan)`
- `renderPlanningArtifact(kind, validatedDraft)`

Implementation notes:

- Planning defaults to Gemini 2.5 Pro.
- PRD, TRD, and build plan generation should each have generator -> critic -> refine loops.
- Planning should use Research citations where market claims or competitor constraints are referenced.
- The TRD must serve the PRD, and the build plan must cover the PRD scope. Do a deterministic required-section check plus a critic consistency pass.
- The artifacts can be Markdown-first with structured metadata validated by Zod before rendering.
- Generic boilerplate should fail the rubric. Planning must include constraints, risks, non-goals, acceptance criteria, and open questions tied to the confirmed idea and research.

Tests/checks:

- `npm run typecheck`
- Full pipeline run Intake -> Research -> Planning with gates.
- Deterministic section checks for PRD/TRD/build plan.
- Cross-document consistency check catches missing requirements or build milestones.
- Research citation references in Planning resolve to Research registry entries.

Acceptance criteria:

- Planning produces `prd`, `trd`, and `build_plan` artifacts.
- Artifacts are coherent with each other and grounded in the research.
- Each document passes its rubric or fails closed with handoff context.
- Human gate works after Planning.
- Full pipeline can complete Intake -> Research -> Planning without invoking Build.

Definition-of-done checklist:

- [ ] `planning.ts` is registered and enabled.
- [ ] PRD, TRD, and build plan schemas validate.
- [ ] Each Planning document has a critic/refine pass.
- [ ] Cross-document consistency check passes.
- [ ] Planning uses Pro by default but respects per-stage config.
- [ ] Build remains disabled/out of scope.
- [ ] `npm run typecheck` passes.

### Milestone 5: Eval Harness and Hardening

Goal: add standing evals, resumability, cost ceilings, and durable storage hardening so prompt/model changes can be shipped safely.

Files to create:

- `src/runtime/evals/index.ts`
- `src/runtime/evals/fixtures.ts`
- `src/runtime/evals/rubrics.ts`
- `src/runtime/evals/judge.ts`
- `src/runtime/evals/report.ts`
- `src/pipeline/store/sqlite.ts`
- `src/pipeline/store/jsonStore.ts` if the current store is split behind an interface
- `src/pipeline/resume.ts`

Files to change:

- `package.json`: add `npm run eval`.
- `src/pipeline/store.ts`: make store an interface/factory and keep JSON store compatibility.
- `src/pipeline/orchestrator.ts`: persist transitions before and after stages and support resume.
- `src/config.ts`: enforce cost ceiling and eval config.
- `src/audit.ts`: add eval and resume events if not already present.
- Docs if implementation decisions differ from the spec.

Key types/functions:

- `EvalFixture`
- `EvalRun`
- `EvalResult`
- `StageEvalResult`
- `runEvalSuite()`
- `runStageEval(fixture, stage)`
- `judgeWithRubric(artifact, rubric)`
- `runDeterministicChecks(artifact, project)`
- `generateEvalReport(results)`
- `ProjectStore` interface
- `JsonProjectStore`
- `SqliteProjectStore`
- `resumeProjectRun(projectId)`

Implementation notes:

- Use Gemini-only judges behind the provider interface. The judge prompt must be separate from generator prompts.
- Deterministic eval checks should carry the most weight where possible, especially citation verification and required sections.
- SQLite should be behind the same store interface. If the target Node version has a stable built-in SQLite API, consider it; otherwise use a small SQLite dependency with a stated reason.
- Crash recovery should persist stage status transitions before and after each stage, plus artifact write completion.
- Cost ceiling enforcement should fail closed, audit context, and hand off rather than truncating silently.

Tests/checks:

- `npm run typecheck`
- `npm run eval`
- Simulated crash/resume path with an in-progress stage.
- Low cost ceiling abort path.
- Store compatibility: existing JSON project data still loads or migrates cleanly.
- Verify no vendor SDK imports exist outside `src/model/gemini.ts`.

Acceptance criteria:

- Eval suite reports per-stage scores over fixture ideas.
- Pipeline is resumable after a crash or interrupted run.
- Cost ceiling aborts cleanly with audit and handoff.
- Store interface supports JSON MVP and SQLite implementation.
- Global definition of done is satisfied.

Definition-of-done checklist:

- [ ] `npm run eval` exists and runs.
- [ ] Eval fixtures cover Intake, Research, and Planning.
- [ ] Rubrics are shared by in-run critics and standing evals.
- [ ] SQLite store exists behind the store interface.
- [ ] Resume path is implemented.
- [ ] Cost ceiling is enforced.
- [ ] `npm run typecheck` passes.

## 4. Sequencing and Dependencies

1. Milestone 1 must land first because all later work depends on the provider interface and Gemini-only runtime.
2. Milestone 2 must land before Research because Research depends on evaluator loops, guardrails, telemetry, cost ceilings, and expanded audit events.
3. Milestone 3 must land before Planning because Planning requires confirmed Research artifacts and a source registry.
4. Milestone 4 completes the three-stage product. It should not introduce Build behavior.
5. Milestone 5 hardens the system and formalizes evals, persistence, resumability, and cost ceilings.

Dependency decisions:

- Add `@google/genai` in Milestone 1.
- Add `zod` in Milestone 1 for model output and artifact validation.
- Add `zod-to-json-schema` if the installed SDK's structured output API expects raw JSON schemas.
- Remove `@anthropic-ai/sdk` in Milestone 1.
- Add a SQLite dependency only in Milestone 5 after checking the target Node version and the cost of native dependencies.

Provider combination rule:

- For Gemini 2.5, do not combine custom function tools, Search grounding, and structured output in a single call unless official docs and installed SDK types later confirm support. Split the workflow instead.

## 5. Risks, Unknowns, and Open Questions

### Risks

- SDK drift: Google docs now show newer `responseFormat` shapes while older snippets mention `responseMimeType` and `responseJsonSchema`. Implementation must compile against `@google/genai@2.7.0` types before committing to field names.
- Grounding is not retrieval: Gemini Search grounding returns citations and URLs, but Jantra still needs to explicitly fetch and hash sources to satisfy deterministic source registry requirements.
- Source fetch failures: some grounded URLs may block fetches, redirect, or return dynamic content. Those sources cannot verify claims unless the registry records a successful retrieval.
- Tool combination limits: Gemini 2.5 docs do not document structured output plus tools or custom function calling plus built-in tools in the same way Gemini 3 does. The provider should fail closed on unsupported combinations.
- Thought summaries can expose sensitive reasoning summaries. Audit should capture useful summaries, but any future client data policy must decide whether to redact or segment audit views.
- Search grounding surcharge can surprise cost rollups after free daily limits. Telemetry must track grounded prompt count, not just tokens.
- Eval judge bias: using Gemini as both generator and judge is allowed by the Gemini-only rule, but prompts and calls must be separate and deterministic checks should be primary where possible.

### Unknowns to verify again at implementation time

- Exact installed TypeScript type names for `GenerateContentConfig.responseFormat` versus legacy fields.
- Whether `@google/genai@2.7.0` exposes stable helper types for grounding metadata and function declarations or whether Jantra should define its own narrow local types.
- Whether explicit caching is worth implementing in Milestone 1 or should start with implicit caching and add explicit caching only after telemetry shows repeated large prefixes.
- Whether a small SQLite dependency is acceptable in Milestone 5 or if the environment can rely on a built-in Node SQLite API.

### Open questions for review

- Should `GEMINI_API_KEY` remain the only supported key name, or should config also accept `GOOGLE_API_KEY` as a fallback while still avoiding implicit SDK env loading?
- Should Intake's critic be implemented in Milestone 1 as a narrow pass, or should Milestone 1 be treated as a pure provider port and Milestone 2 be the point where Intake becomes acceptable under the generator != critic rule? My recommendation is a narrow Milestone 1 critic.
- What default per-project cost ceiling should be used for dogfooding? The spec requires enforcement but does not set a number.
- Should Research allow claims marked `unverified`, or should final reports drop unverified claims entirely and list them only in an "open questions" section? My recommendation is to abstain in the body and place unverified leads in open questions.

## 6. Milestone Definition-of-Done Summary

### Milestone 1

- [ ] Gemini provider implemented.
- [ ] Anthropic removed from runtime code and dependencies.
- [ ] Intake and support agent run through provider.
- [ ] Intake summary validated with Zod.
- [ ] Intake critic pass exists.
- [ ] Model calls audited with usage, thinking summaries where available, and cost.
- [ ] Typecheck passes.

### Milestone 2

- [ ] Shared evaluator loop implemented.
- [ ] Telemetry and cost rollup implemented.
- [ ] Expanded audit event types implemented.
- [ ] Guardrails include untrusted web content and output checks.
- [ ] Typed fail-closed errors implemented.
- [ ] Intake uses shared rubric/evaluator path.
- [ ] Typecheck passes.

### Milestone 3

- [ ] Research stage implemented and registered.
- [ ] Source registry persists fetched and hashed sources.
- [ ] Citation verification is deterministic.
- [ ] Prompt-injection handling protects web content.
- [ ] Research report has verified citations or abstains.
- [ ] Research critic/rubric pass active.
- [ ] Gate works after Research.
- [ ] Typecheck passes.

### Milestone 4

- [ ] Planning stage implemented and registered.
- [ ] PRD, TRD, and build plan generated.
- [ ] Each document has critic/refine loop.
- [ ] Cross-document consistency check passes.
- [ ] Planning uses Research citations where relevant.
- [ ] Full Intake -> Research -> Planning pipeline runs.
- [ ] Build remains disabled.
- [ ] Typecheck passes.

### Milestone 5

- [ ] Eval harness and fixtures implemented.
- [ ] `npm run eval` reports per-stage scores.
- [ ] Rubrics reused by runtime critics and eval suite.
- [ ] Store interface supports JSON and SQLite.
- [ ] Pipeline can resume after interruption.
- [ ] Cost ceiling fails closed with audit and handoff.
- [ ] Typecheck and eval pass.


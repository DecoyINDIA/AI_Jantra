# Milestone 6 — Output Quality Hardening

Status: implementation brief. Unlike the original plan, this one authorizes code changes. Follow `AGENTS.md` hard rules at all times. Build the changes in the order below; each is independently shippable and `npm run typecheck` + `npm run eval` must stay green after every one.

Goal: raise the quality, grounding, and verifiability of the artifacts the pipeline produces per run, and make every Codex change verifiable end to end without a live API key.

## Binding constraints (do not violate — from AGENTS.md)

- Gemini 2.5 only, behind `src/model/provider.ts`. No vendor SDK in stages.
- **Citation verification stays deterministic (plain code, not a model call).** The semantic upgrade in Change 1 is achieved with verbatim quote matching, not by asking a model "is this supported." A model entailment signal may be added only as an *advisory, audited* score that never relaxes the deterministic gate.
- Generator ≠ critic. Every refine round is a separate call with a separate prompt.
- Fail closed. Audit everything with `clientId`. Stage 4 stays disabled.
- Validate every structured model output with Zod. Never trust raw JSON.

Read the current code before editing: `src/pipeline/research/*`, `src/pipeline/stages/*`, `src/runtime/evaluator.ts`, `src/runtime/telemetry.ts`, `src/model/*`, `src/config.ts`.

---

## Change 1 — Deterministic quote-anchored citation verification (highest priority)

Problem: `verifyClaims` in `src/pipeline/research/citationVerifier.ts` only checks that each `sourceId` is registered. A claim that cites a real source which does not support it passes. The product's whole value is grounding, so this is the top gap.

Design (stays deterministic):

- Extend the synthesis output so every claim carries one verbatim supporting quote per cited source.
  - `src/pipeline/research/schemas.ts`: in `sectionClaimsSchema`, change each claim to `{ text, citations: [{ sourceId, quote }] }` where `quote` is a non-empty verbatim span the model copied from the provided source excerpt.
- `src/pipeline/types.ts`: extend `Claim` with `citations: { sourceId: string; quote: string }[]` and a `support: "verified" | "unverified"` field. Keep `sourceIds` derivable from `citations` for the existing appendix/rendering, or migrate call sites.
- `src/pipeline/research/citationVerifier.ts`: rewrite `verifyClaims` to take the per-source registered text (pass a `Map<sourceId, normalizedText>`), and mark a claim `verified` only if:
  1. it has at least one citation, and
  2. every cited `sourceId` is registered, and
  3. every `quote` actually occurs in that source's normalized text (case-folded, whitespace-collapsed substring match; reuse a small `normalize()` helper).
  Reject (mark unverified) and audit `citation_rejected` with the failing reason (`unknown_source` | `quote_not_found` | `no_citation`) otherwise; audit `citation_verified` on success.
- `src/pipeline/stages/research.ts`: pass the source text map (already available as `sourceTexts`) into `verifyClaims`; the synthesis prompt must instruct the model to quote verbatim from the provided `[sourceId]` excerpts and never invent quotes.

Optional advisory layer (do not gate on it): add a separate critic call that scores entailment 1–5 per section and audit it as `eval_score` purpose `entailment`. The deterministic quote check remains the gate.

Tests/checks:
- Unit: a claim whose quote is absent from its source is rejected; present quote with registered source passes; empty citations rejected.
- `npm run eval` deterministic research judge updated to exercise quote matching.

Acceptance: no claim is marked `verified` unless its quote is found verbatim in a registered source. Verification still does zero model calls.

---

## Change 2 — Real critique → refine loops in Research and Planning

Problem: `runEvaluatorLoop` (`src/runtime/evaluator.ts`) supports generate → critique → refine → `maxRounds`, but nothing uses it. Research critiques once and fails closed (`src/pipeline/stages/research.ts`); Intake critiques once. Drafts one revision from passing are discarded.

Changes:
- Route Research report assembly through `runEvaluatorLoop` with `maxRounds = config.maxEvalRounds`: `generate` = assemble report from synthesized sections; `critique` = the existing research critic; `refine` = a separate model call that revises the report given the critique notes (regenerate weak sections, not the whole report, where practical). Keep the deterministic citation gate as a hard precondition before the critic runs — refine must never fabricate citations.
- Route each Planning document (PRD, TRD, build plan) through `runEvaluatorLoop` similarly, in `src/pipeline/stages/planning.ts`.
- Audit each round's `eval_score` with the `round` number (the loop already does this).

Tests/checks: force a failing first critique in a unit/fixture path and assert a refine round runs and the second draft is re-scored; assert fail-closed still triggers after `maxRounds`.

Acceptance: a draft that fails round 1 but passes round 2 is accepted and audited with two `eval_score` rounds. Generator and critic remain separate calls.

---

## Change 3 — Multi-query research and source-quality scoring

Problem: `groundedSearchAndFetch` runs one grounded call per section, takes the top 6 citations, and ranks nothing. The spec called for source quality scoring (prefer primary, recent, reputable); it was skipped.

Changes (`src/pipeline/research/*`, `src/pipeline/stages/research.ts`):
- Let the research planner emit 2–4 search queries per section (extend `researchPlanSchema`). Run them (respecting `config.researchConcurrency`) and union the citations.
- Global source dedup by normalized URL across all sections before fetch, so the registry has no duplicates.
- Add `src/pipeline/research/sourceQuality.ts` with `scoreSource(source): number` — deterministic signals only (HTTPS, known primary/official/reputable host patterns, presence of a date, path depth). Store the score on the registered `Source`. Prefer higher-scored sources in synthesis ordering and surface the score in the source appendix.
- Cap total fetched sources per run via config to bound cost (`JANTRA_MAX_SOURCES`, default e.g. 24); log when the cap drops sources (no silent truncation).

Tests/checks: dedup unit test; `scoreSource` ranks an official primary host above an anonymous blog; cap logs dropped sources.

Acceptance: research draws from multiple queries and deduped, quality-ranked sources; the appendix shows scores; the cap is explicit and logged.

---

## Change 4 — Claim-level cross-document traceability in Planning

Problem: `src/pipeline/planning/consistency.ts` is keyword presence only.

Changes:
- Give each PRD requirement a stable ID in the PRD schema (`req-1`, `req-2`, …) in `src/pipeline/planning/schemas.ts`.
- Require the TRD and build plan schemas to reference requirement IDs they address.
- Rewrite `checkCrossDocumentConsistency` to build a coverage matrix: every PRD requirement ID must be referenced by at least one TRD section and at least one build-plan milestone. Return precise issues for any uncovered requirement (`req-3 not covered by TRD`).
- Keep the existing required-section keyword checks as a secondary signal, plus the critic consistency pass.

Tests/checks: a PRD requirement absent from the build plan fails the matrix with a specific issue; full coverage passes.

Acceptance: consistency is requirement-ID coverage, not keyword presence; gaps name the exact requirement.

---

## Change 5 — Explicit context caching for stable prefixes

Problem: the idea summary is re-sent to every research section; the research report is re-sent to PRD/TRD/build. Only implicit caching is used.

Changes (`src/model/gemini.ts`, `src/model/provider.ts`, stages):
- Add optional explicit caching via `ai.caches.create(...)` and `config.cachedContent` for large stable prefixes, behind a `GenerateOptions.cacheKey` / provider-managed cache handle. Hide all SDK cache types behind the provider interface.
- Use it for: the idea summary across research sections, and the confirmed research report across the three planning documents.
- Only cache prefixes above the documented implicit-cache minimum; respect TTL and audit cached token counts (telemetry already records `cachedTokens`).
- Gate behind `config.explicitCache` (default on for Pro/planning, configurable), with a clear fallback to implicit caching if creation fails (fail soft on caching, never on correctness).

Tests/checks: typecheck; a run with caching enabled records non-zero `cachedTokens` on the second+ planning call (verify against live key manually; do not require key in CI).

Acceptance: repeated large prefixes are cached explicitly where economical, with audited cached-token accounting and a safe fallback.

---

## Change 6 — Parallelism and budget tuning

Changes (`src/config.ts`): expose and modestly raise safe concurrency (`researchConcurrency`, synthesis fan-out) with env overrides and sane caps; document rate-limit considerations. No behavior change beyond throughput.

Acceptance: concurrency is config-driven with documented defaults; no correctness change.

---

## Change 7 — Mock provider + full-pipeline smoke test (verifiable without a key)

Problem: only typecheck and deterministic evals can be checked statically; the real Intake → Research → Planning path needs a live key, so Codex changes are not verifiable end to end in CI.

Changes:
- Add `src/model/mock.ts`: `MockProvider implements ModelProvider`, replaying canned `ModelResult`s keyed by call purpose/sequence from a fixture file (`src/runtime/evals/fixtures/transcript.json` or similar). It must return well-formed tool calls, structured JSON, grounding citations, and usage so every stage path executes.
- Add a seam in `src/model/index.ts`: `createProviderForStage` returns the mock when `JANTRA_PROVIDER=mock` (and a fixture path env is set), otherwise the real Gemini provider. Keep the orchestrator unchanged.
- Stub the human gate I/O for the smoke run (auto-answers).
- Add `npm run smoke` running `Intake → Research → Planning` with the mock provider and asserting: artifacts produced, every research claim verified against the fixture sources, planning consistency passes, audit contains the expected event types, Build stays disabled.

Tests/checks: `npm run smoke` passes with no `GEMINI_API_KEY` present.

Acceptance: the full pipeline runs deterministically offline; one command proves end-to-end behavior for every future change.

---

## Change 8 — Model-judge standing evals (behind the key)

Problem: the eval suite (`src/runtime/evals/index.ts`) is all deterministic judges; judgment-heavy criteria (balance, completeness, entailment) are unscored.

Changes:
- Add model-judge fixtures in `src/runtime/evals/` that call provider judges only when `GEMINI_API_KEY` is set; skip cleanly with a `SKIP` line otherwise. Judge prompts are separate from generator prompts.
- Keep deterministic checks as the primary gate; the model judge is supplementary and its scores are reported, not the sole pass/fail.

Tests/checks: `npm run eval` still passes with no key (model judges report `SKIP`); with a key, model judges produce scores in the report.

Acceptance: evals cover judgment-heavy criteria when a key is present, and remain green and deterministic without one.

---

## Sequencing

1. Change 1 (quote-anchored verification) — foundational; everything downstream trusts it.
2. Change 2 (refine loops) — depends on 1 so refine cannot fabricate past the gate.
3. Change 3 (multi-query + quality) — broadens evidence feeding 1 and 2.
4. Change 4 (traceability) — Planning quality, independent of 1–3.
5. Change 7 (mock + smoke) — land early-ish if helpful; required before declaring done.
6. Changes 5, 6, 8 — cost/scale/eval hardening, last.

## Definition of done (whole milestone)

- [ ] Citation verification is quote-anchored and deterministic; no `verified` claim lacks a verbatim source quote.
- [ ] Research and Planning run real critique → refine loops with audited rounds; fail closed after `maxRounds`.
- [ ] Research uses multi-query search, deduped and quality-scored sources, with an explicit, logged source cap.
- [ ] Planning consistency is requirement-ID coverage with precise gap reporting.
- [ ] Explicit caching for stable prefixes with audited cached tokens and safe fallback.
- [ ] `npm run smoke` runs the full pipeline offline with the mock provider and asserts grounding + gates + Build-disabled.
- [ ] `npm run eval` green without a key; model judges add coverage when a key is present.
- [ ] `npm run typecheck` clean. No vendor SDK imports outside `src/model/gemini.ts`. Stage 4 still disabled.

---

## Paste-to-Codex kickoff block

> Paste everything below to Codex as its instruction.

You are Codex, the coding agent for **Jantra AI**. Implement **Milestone 6 — Output Quality Hardening**, specified in `docs/IMPROVEMENTS_PLAN.md`. This milestone authorizes code changes.

Before editing, read `AGENTS.md`, `docs/BUILD_SPEC.md` (§ relevant to Research/Planning/evals), and the current code under `src/`. Obey every hard rule in `AGENTS.md` — in particular: **citation verification must stay deterministic (no model call in the gate)**, generator ≠ critic, fail closed, audit everything with `clientId`, validate all model JSON with Zod, and keep Stage 4 disabled.

Implement the changes in the sequencing order in the plan (1, 2, 3, 4, 7, then 5, 6, 8). After each change: run `npm run typecheck` and `npm run eval` and keep both green; add the tests named in that change. Do not combine structured output with tools or grounding in a single Gemini 2.5 call — the provider already enforces this; respect it.

When done, run `npm run typecheck`, `npm run eval`, and `npm run smoke`, then summarize what changed per file, what you verified, and any open questions. If anything in the plan conflicts with `AGENTS.md` or `BUILD_SPEC.md`, stop and flag it rather than guessing.

# Jantra AI — Intake + Research Redesign

**Implementation Briefing Document**
Prepared for: AI Builder (Codex / Antigravity)
Scope: `@jantra/runtime` (the `src/` tree at repo root)

This is a direct, codebase-grounded handoff. It tells you exactly what to change, in which files, with the full prompts and schemas to paste. It is not a set of suggestions; it is the product spec. Where the original founder brief and the codebase reality differ, this document is authoritative because it is written against the actual code.

---

## 0. Reading order and ground rules

- Implement in TypeScript, ESM, `zod` v4 for schemas (the repo uses `z.toJSONSchema(...)` and `z.enum([...])`). Match the surrounding code style.
- Do **not** add new runtime dependencies.
- Every model call in this runtime goes through `ctx.provider.generate(...)` with a `purpose` string. The mock provider (`src/model/mock.ts`) replays fixtures keyed by `stage:purpose`. **Any new `purpose` you introduce needs matching fixture entries** (see §7) or the smoke test throws "Mock provider has no fixture entry".
- Gates: Intake and Research both have `gate: "human"` in `src/agents/planningPipeline.ts`. Do not change the gate wiring.
- Verify with: `npm run typecheck`, then `npm run smoke`, then `npm run eval`. All three must pass.

---

## 1. Why this change exists

The current Intake stage (`src/pipeline/stages/intake.ts`) is a generic clarifying-question loop. It captures `title / problem / solution / targetUsers / keyFeatures / constraints / successCriteria / openQuestions` and scores the result on `specificity / completeness / researchability / noInventedDetails`. It has three problems:

1. No funnel logic — it asks for whatever the model decides, including a free-text `constraints` field and the prompt literally asks for "budget, timeline" (exact figures).
2. It never captures **why** the founder is building this or **what they are building toward** — the two anchors that should make Research intentional.
3. `successCriteria` drifts into viability judgement, which is Research's job, not Intake's.

The current Research stage (`src/pipeline/stages/research.ts`) is strong on machinery — grounded search, source hashing/registration, per-claim citation verification with verbatim quotes, and an evaluator/refine loop. **Keep all of that.** What it lacks is structure: the planner free-forms 4–8 sections, it does not read founder anchors, there is no guaranteed Viability section, and there is no neutral viability summary at the human gate.

This redesign adds the missing structure to both stages while preserving the citation/verification machinery.

---

## 2. Stage boundary (do not blur)

| Intake (Stage 1) | Research (Stage 2) |
|---|---|
| Capture the raw idea in the founder's words | Assess market viability with cited evidence |
| Capture what the founder knows now | Discover what they don't know yet |
| Capture build + founder philosophy as anchors | Use those anchors to focus research |
| Ask minimum questions via adaptive funnel | Fan out across demand, competition, risk, economics |
| Produce the Idea Summary artifact | Flag red flags, saturation, unsustainable economics |
| **Never** suggest paths, validate, or assess viability | Present viability data; **never** make a go/no-go call |

---

## 3. Friction decision (settled — do not expand)

Intake stays at **~5 questions**. A Perplexity reference doc proposed a 10–12 question VC-style intake (team, market size, traction, business model, round). That is rejected: it adds friction and, more importantly, it pulls market/traction/viability into Intake, violating §2. The VC-grade material (bottom-up TAM/SAM/SOM, Porter's Five Forces, SaaS benchmarks) belongs in the **Research Viability Assessment** (§5.3), not in Intake.

---

## 4. INTAKE — what to implement

File: `src/pipeline/stages/intake.ts`. Both `runIntake` (synchronous CLI path) and `runIntakeReentrant` (the pipeline path via `runnerKind: "planning.intake"`) exist and duplicate logic. Update **both**; factor the shared submit-evaluation logic into one helper so they cannot drift.

### 4.1 Adaptive funnel (behavioral, enforced via prompt + schema + critic)

Implement the funnel as system-prompt guidance + required schema fields + a deterministic critic, **not** as a hardcoded state machine. This preserves the existing reentrant runner and the "skip what's already known" adaptivity.

Question flow the prompt must drive:

- **Q1 Core idea** (open): "Tell me about the idea you want to build, in your own words. There are no wrong answers here." Accept any length; store verbatim as `raw_idea`.
- **Q2 Problem clarity** (adaptive): "Who is experiencing this problem, and when does it hurt them most?" Skip if Q1 already names a user and a pain.
- **Q3 Build philosophy** (REQUIRED, category): "What is your primary goal for this build right now?" — 4 options (§4.2).
- **Q4 Founder philosophy** (REQUIRED, category): "What is driving this idea for you personally? Pick the closest fit." — 5 options (§4.2).
- **Q5 Constraints** (OPTIONAL, multi-select, only if the idea has real resource/regulatory complexity): "Are there any constraints we should keep in mind as we research? Select all that apply."

### 4.2 Idea Summary schema (replace the existing `ideaSummarySchema`)

Use the original brief's **snake_case field names and enum values**. Field naming is internal — downstream consumers (Research planner, Planning stage `src/pipeline/stages/planning.ts:251`, the embed widget `packages/embed-widget/src/index.ts:315`) only read the rendered `artifact.content` markdown and `artifact.title`, never individual schema fields. So renaming fields is safe **as long as you keep producing a rendered `content` string and set `project.title`**.

```ts
const BUILD_PHILOSOPHY = {
  mvp_pitch: "Bare-bones MVP to validate and pitch",
  lean_profitable: "Lean build, self-funded, profitable early",
  premium_experience: "Premium product with strong user experience",
  exploring: "Still exploring, not sure yet",
} as const;

const FOUNDER_PHILOSOPHY = {
  self_experienced: "I experienced this problem myself",
  lifestyle: "I want financial independence or a lifestyle business",
  scale_exit: "I want to build, grow, and eventually exit",
  mission_driven: "I am passionate about a specific mission or cause",
  opportunistic: "I see a market opportunity and want to capture it",
} as const;

const CONSTRAINT_FLAGS = {
  speed_over_cost: "Speed matters more than cost right now",
  limited_tech: "Limited technical resources or no tech team yet",
  regulatory: "Known regulations or compliance requirements in this space",
  geo_language: "Needs to work in a specific geography or language",
  none: "No major constraints that I know of",
} as const;

const ideaSummarySchema = z.object({
  title: z.string().min(3),
  raw_idea: z.string().min(20),
  problem: z.string().min(10),
  solution: z.string().min(10),
  target_users: z.string().min(5),
  build_philosophy: z.enum(Object.keys(BUILD_PHILOSOPHY) as [keyof typeof BUILD_PHILOSOPHY]),
  founder_philosophy: z.enum(Object.keys(FOUNDER_PHILOSOPHY) as [keyof typeof FOUNDER_PHILOSOPHY]),
  constraints_flags: z.array(z.enum(Object.keys(CONSTRAINT_FLAGS) as [keyof typeof CONSTRAINT_FLAGS])).default([]),
  key_features: z.array(z.string().min(3)).min(1),
  open_questions: z.array(z.string()).default([]),
});
```

- `BUILD_PHILOSOPHY` and `FOUNDER_PHILOSOPHY` must be **exported** — the Research stage imports them to render anchors with human labels.
- `submit_idea_summary` tool: update `inputSchema` to the snake_case properties above, with `enum` arrays on `build_philosophy`, `founder_philosophy`, and `constraints_flags` items. `required`: everything except `constraints_flags`.

### 4.3 Rendered summary (`renderSummary`)

Render markdown with sections for Raw idea, Problem, Solution, Target users, Key features, Build philosophy (label + key), Founder philosophy (label + key), Constraints, Open questions. **Append a machine-readable anchor marker as the last line** so Research can parse it deterministically:

```
<!-- anchors: build_philosophy=<key>; founder_philosophy=<key> -->
```

### 4.4 System prompt (replace `SYSTEM_PROMPT`)

Use this verbatim core, then append the category option lists so the funnel can surface them (brief rule 7.1: category questions must present options explicitly):

```
You are the Intake specialist at Xolver, a studio that turns ideas into built products.

Your job is to understand a founder's idea well enough that a research team can investigate it with intention. You are the first touchpoint, so be warm, concise, and direct.

How to work:
- Ask focused questions, one or two at a time. Never ask more than two at once.
- Follow the funnel: each answer shapes the next question. Do not ask what is already known.
- For questions about constraints, budgets, or capacity: use categories, not exact figures.
- You must capture build_philosophy (what they want to build toward) and founder_philosophy (why they are building this). These are required fields.
- If the founder does not know the answer to something, record it as an open question for Research. Do not pressure them.
- When you have enough to fill the Idea Summary schema, call submit_idea_summary.

What you must NOT do:
- Do not assess market viability. That is Research's job.
- Do not suggest which path to take. That is Research's job after seeing the data.
- Do not invent features, users, or constraints the founder did not mention.
- Do not use em dashes.

Tone: plain, warm, concrete. Short sentences. No filler.
```

Append, after the core, a block listing the `build_philosophy` (4), `founder_philosophy` (5), and `constraints_flags` (5) keys and labels, instructing the model to present options explicitly and store the chosen key.

### 4.5 Critic pass (replace `critiqueSummary` + `intakeCritiqueSchema`)

Two layers:

**(a) Deterministic checks** — gaps a schema cannot express. These produce a follow-up question, they do **not** fail the stage:
- `solution` must be distinct from `problem` (reject if equal or one contains the other) → follow-up: "What would your solution actually do that is different from just restating the problem?"
- (Length and enum validity are already enforced by `ideaSummarySchema`; a malformed `submit` still throws `SchemaValidationError` defensively, which is acceptable because the tool marks those fields required.)

**(b) Model quality scoring** — schema:
```ts
const intakeCritiqueSchema = z.object({
  scores: z.object({
    specificity: z.number().min(1).max(5),
    researchability: z.number().min(1).max(5),
    noInventedDetails: z.number().min(1).max(5),
    philosophyCaptured: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
  followUpQuestions: z.array(z.string()).default([]),
});
```
- Rubric: `{ id: "intake", passingScore: 4, criteria: ["specificity","researchability","noInventedDetails","philosophyCaptured"] }`. All four must be ≥4.
- `philosophyCaptured` checks both anchors are present and internally consistent with the idea.
- `specificity` = concrete problem anchored to a real user/context. `researchability` = enough anchors for targeted queries. `noInventedDetails` = no market claims or features the founder didn't mention.

**Control flow:** allow up to **2 follow-up rounds total** (deterministic + model combined). On each non-passing critique with rounds remaining, ask `[...deterministicFollowUps, ...critique.followUpQuestions].slice(0, 2)`. After 2 rounds still failing → `StageFailedClosedError`. Track the round count in `state.data.followUpRounds` (reentrant) / a local var (sync). Record the eval once via `ctx.audit.record("eval_score", ...)` and push to `project.stages[stageId].evals` — centralize this in the shared helper so both runners record identically.

### 4.6 Agent behavior rules (enforce in prompt + runner)
- Never ask for exact figures; categories or descriptive ranges only.
- Never more than 2 questions at a time.
- Never re-ask what was answered.
- Ambiguous answer → one clarifying question.
- If the founder doesn't know → record as `open_questions`, move on.
- Never invent features/users/constraints/market claims.

### 4.7 Also update
- `src/runtime/evals/rubrics.ts` → `intakeRubric.criteria` to `["specificity","researchability","noInventedDetails","philosophyCaptured"]` (keep it at 4 criteria — the eval registry asserts the count).

---

## 5. RESEARCH — what to implement

Files: `src/pipeline/stages/research.ts`, `src/pipeline/research/schemas.ts`, `src/policy.ts`.

### 5.1 Six required sections, always planned

Five are **evidence sections** (web-searched). The sixth, **Founder-Anchor Fit**, is **interpretive** — synthesized from the other five plus the anchors, with **no web search and no citations** (it asserts no new market facts; §6.1 of the founder brief defines it as "how does the market evidence align with the anchors").

Define the five evidence sections as a constant array of `{ key, title, question, guidance }`:

| key | title | guidance focus |
|---|---|---|
| `market_demand` | Market Demand | search interest, community complaints, waitlists, surveys; stated interest vs evidence of spend |
| `competitive_landscape` | Competitive Landscape | direct competitors, incumbents, free/manual alternatives, positioning, visible pricing, weaknesses |
| `viability_assessment` | Viability Assessment | **enriched — see §5.3** |
| `regulatory_legal` | Regulatory and Legal | licensing, data protection, sector compliance, liability; variation by geography |
| `technical_feasibility` | Technical Feasibility | buildable with available tools/APIs; heavy infra/data/model/third-party dependencies and limits |

### 5.2 Plan schema (replace `researchPlanSchema` in `src/pipeline/research/schemas.ts`)

Make the planner deterministic by keying queries to the five fixed sections instead of free-forming section titles:

```ts
const queryList = z.array(z.string().min(5)).min(2).max(4);
export const researchPlanSchema = z.object({
  market_demand: queryList,
  competitive_landscape: queryList,
  viability_assessment: queryList,
  regulatory_legal: queryList,
  technical_feasibility: queryList,
});
```

`planResearch(ctx, idea, anchors)` reads the anchors and instructs the planner to weight queries toward what `build_philosophy` / `founder_philosophy` make relevant, while always covering every section. Build `searchJobs` by `EVIDENCE_SECTIONS.flatMap(s => plan[s.key].map(q => ({ section: s, query: q })))`.

### 5.3 Viability Assessment enrichment (fold in the market-research practices)

The `viability_assessment` section's synthesis guidance must instruct the model to:
- Size the opportunity **bottom-up first** (target customers × realistic annual revenue per customer), then sanity-check against any top-down figures.
- Read industry structure through **Porter's Five Forces** (entry barriers, buyer/supplier power, substitutes, rivalry).
- Where the model is SaaS-like, compare against **benchmark bands, not cutoffs**: gross margin ~60–70%+, LTV:CAC ≥ 3, CAC payback 12–24 months, churn <~5%/mo SMB and <2% enterprise.
- Flag when pricing norms or unit economics look structurally unsustainable.

Pass each section's `guidance` into `synthesizeSection` (extend its signature to take the `SectionDef`, not just a title string) and append it to the synthesis user message.

### 5.4 Read the anchors

Add `readAnchors(idea: Artifact)` that regex-parses the `<!-- anchors: ... -->` marker (§4.3) into `{ buildPhilosophy, founderPhilosophy }`, defaulting to `"unspecified"`. Add `anchorLegend(anchors)` that maps the keys back to human labels via the exported `BUILD_PHILOSOPHY` / `FOUNDER_PHILOSOPHY` from `./intake.js`. Pass anchors into the planner, the anchor-fit synthesis, and the viability summary.

### 5.5 Founder-Anchor Fit synthesis (new `purpose: "founder_anchor_synthesis"`)

Schema:
```ts
export const founderAnchorSchema = z.object({
  summary: z.string().min(20),
  alignmentPoints: z.array(z.string().min(8)).default([]),
  tensions: z.array(z.string().min(8)).default([]),
});
```
Input: anchor legend + a digest of the five evidence sections (summary + verified claim texts + risks). System prompt: use only the findings provided, no new market facts, no citations, **no go/no-go recommendation**.

### 5.6 Viability Summary at the human gate (new `purpose: "viability_summary"`)

Schema:
```ts
export const viabilitySummarySchema = z.object({
  redFlags: z.array(z.string().min(8)).default([]),
  opportunities: z.array(z.string().min(8)).default([]),
  economicsNote: z.string().min(20),
});
```
Generated after the five sections synthesize, from the same digest + anchors. **Render it as the leading section of the report** (right after `## Basis`), because the report artifact is what the human sees at the Research gate. Required content: key red flags (saturation, funded competitors, no demand, unsustainable economics), key opportunities (underserved niche, weak solutions, growing demand), and one economic-sustainability note. **Neutral framing. Present data only. Never recommend, never say go/no-go.**

### 5.7 Report rendering

`renderReport(idea, viability, sections, anchorFit, sources)`:
1. `# Market research report - {title}` + `## Basis`
2. `## Viability Summary` (red flags / opportunities / economic sustainability) + an explicit line: "This summary presents what the research found so the founder can decide how to proceed. It is not a recommendation."
3. The five evidence sections (existing render: verified claims with `[src_x]` ids, risks/caveats, unverified leads).
4. `## Founder-Anchor Fit` (summary, where evidence aligns, where there is tension).
5. `## Sources` (`sourceAppendix`).

`refineReport`'s system prompt must be updated to **preserve every section including Viability Summary and Founder-Anchor Fit, keep framing neutral, and never add a go/no-go recommendation.**

### 5.8 No go/no-go enforcement (`src/policy.ts`)

In `runArtifactOutputChecks`, for `artifact.stage === "research"`, add a **non-blocking** flag `viability_recommendation_language` when the content matches recommendation patterns (`/\bwe recommend\b/i`, `/\bour recommendation\b/i`, `/\bgo\/no-go\b/i`, `/\byou should (not )?(build|launch|proceed|invest|pursue)\b/i`, `/\bdo not (build|launch|proceed|invest|pursue)\b/i`). Non-blocking because the phrasing can legitimately appear inside a quoted source; it surfaces for review only. Do not change the existing `allowed` logic (still blocks only on `verified_claim_without_quote`).

### 5.9 Keep unchanged
- Grounded search, source registration/hashing, `dedupeCitationCandidates` / `rankAndCapCitationCandidates`, `fetchSelectedSources`, `verifyClaims`, the evaluator loop, `researchCritiqueSchema` (factualAccuracy / citationAccuracy / completeness / sourceQuality / balance), and the final output-check gate.
- Only **evidence-section claims** go into `project.claims`. Founder-Anchor Fit and Viability Summary must **not** push claims (the smoke test asserts every claim in `project.claims` is verified with a quote).

---

## 6. Files to touch (summary)

| File | Change |
|---|---|
| `src/pipeline/stages/intake.ts` | New schema, enums (exported), submit tool, system prompt, deterministic + model critic, 2-round follow-up cap, shared submit-eval helper; update both runners |
| `src/pipeline/research/schemas.ts` | New keyed `researchPlanSchema`; add `founderAnchorSchema`, `viabilitySummarySchema`, section-key constant/type |
| `src/pipeline/stages/research.ts` | Section defs, `readAnchors`/`anchorLegend`/digest, keyed planner, section guidance, anchor-fit + viability synthesis, new render, refine-prompt update, import `BUILD/FOUNDER_PHILOSOPHY` from `./intake.js` |
| `src/policy.ts` | Non-blocking `viability_recommendation_language` research flag |
| `src/runtime/evals/rubrics.ts` | Intake rubric criteria → 4 new criteria |
| `src/runtime/evals/fixtures/transcript.json` | Rewrite intake + research entries (see §7) |

---

## 7. Fixture / test updates (critical — the smoke test is fixture-driven)

`src/runtime/evals/smoke.ts` runs the whole pipeline against `MockProvider`, which replays `src/runtime/evals/fixtures/transcript.json` keyed by `stage:purpose` with a per-key cursor. You must supply **at least as many entries per `purpose` as there are calls**.

Call counts after this redesign (default `researchConcurrency: 4`, `synthesisConcurrency: 3`):
- `intake:generator` — 1 (the `submit_idea_summary` call). Args must satisfy the new snake_case schema, include both philosophy enums, `raw_idea` ≥ 20 chars, and `solution` distinct from `problem`.
- `intake:critic` — 1. Text must be `{"scores":{"specificity":5,"researchability":5,"noInventedDetails":5,"philosophyCaptured":5},"passed":true,"notes":"...","followUpQuestions":[]}`.
- `research:planner` — 1. Text is the keyed JSON: `{"market_demand":[...2],"competitive_landscape":[...2],"viability_assessment":[...2],"regulatory_legal":[...2],"technical_feasibility":[...2]}`.
- `research:grounded_search` — **10** (5 sections × 2 queries). **Gotcha:** searches run concurrently, so the job→fixture-entry pairing is not positional. To stay deterministic, make **every** `grounded_search` entry cite **all four** existing source files (`market.html`, `pricing.html`, `competitors.html`, `risks.html`). Then every section gets all four sources attached and any section's synthesis can resolve its own `src_*` claims regardless of pairing.
- `research:section_synthesis` — **5**. Each cites among `src_market` / `src_pricing` / `src_competitors` / `src_risks` with **verbatim** quotes from those HTML files (the citation verifier matches quotes exactly).
- `research:founder_anchor_synthesis` — 1 (matches `founderAnchorSchema`).
- `research:viability_summary` — 1 (matches `viabilitySummarySchema`; avoid recommendation phrasing).
- `research:critic` — 1 (unchanged 5-criteria schema).
- Planning + support entries: leave as-is.

Source IDs derive from filename in `src/pipeline/research/sourceRegistry.ts` (`market.html` → `src_market`, etc.). The four files live in `src/runtime/evals/fixtures/sources/`; reuse them, do not add new ones.

The smoke test (`smoke.ts`) asserts: an `idea_summary`, a `research_report`, a `prd`, a `trd`, a `build_plan`; that `project.claims` is non-empty and **every** claim is verified with a non-empty quote; and that the audit log contains `run_start`, `model_call`, `source_registered`, `citation_verified`, `eval_score`, `stage_gate`, `cost_rollup`. Do not weaken these.

---

## 8. Implementation checklist

**Intake**
- [ ] Funnel driven by system prompt; Q2 skipped when Q1 already names user + pain
- [ ] `build_philosophy` exactly 4 options; `founder_philosophy` exactly 5; presented explicitly in questions
- [ ] No exact-figure inputs anywhere; constraints are category flags
- [ ] Idea Summary schema = all fields in §4.2; rendered content + anchor marker
- [ ] Critic = deterministic checks + model scoring on the 4 criteria, pass ≥4 each
- [ ] ≤2 targeted follow-ups; fail closed only after 2 rounds
- [ ] System prompt replaced with §4.4
- [ ] Both `runIntake` and `runIntakeReentrant` updated via one shared helper
- [ ] `rubrics.ts` intake criteria updated

**Research**
- [ ] Planner reads anchors and emits keyed queries for all 5 evidence sections
- [ ] All 6 sections always present (5 evidence + Founder-Anchor Fit)
- [ ] Viability Assessment guidance includes bottom-up sizing + Porter + benchmark bands
- [ ] Viability Summary leads the report: red flags, opportunities, economics note, neutral
- [ ] Founder-Anchor Fit interpretive, no citations, no claims into `project.claims`
- [ ] No go/no-go: prompts + refine prompt + non-blocking policy flag
- [ ] Citation/verification machinery untouched

**Tests**
- [ ] `npm run typecheck` clean across all workspaces
- [ ] `npm run smoke` passes
- [ ] `npm run eval` passes (11/11, model-judge skipped without `GEMINI_API_KEY`)

---

## 9. Acceptance behaviors (smoke-level)

- A founder with zero prior knowledge completes Intake in under ~6 exchanges.
- A founder who skips the constraints question still yields a valid Idea Summary (`constraints_flags` defaults to `[]`).
- A research report for an economically weak idea still presents data neutrally (no recommendation language).
- The Intake critic cannot pass a summary missing `build_philosophy` or `founder_philosophy` (the tool requires them; `philosophyCaptured` scores them).

---

## 10. Open questions for the founder (resolve before/while building)

- Field naming: this brief uses the original snake_case (`raw_idea`, `target_users`, `build_philosophy`, …). Confirm that's preferred over the codebase's camelCase house style. (It's internal-only; downstream reads `content`/`title`.)
- Funnel: confirm the prompt-driven adaptive funnel is acceptable versus a rigid scripted question sequence. (Prompt-driven fits the existing reentrant runner and keeps adaptivity.)

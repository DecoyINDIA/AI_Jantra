# Jantra AI — Master Build Specification (Codex Handover)

> **Audience: the coding agent (Codex) that will build this.** This is the single source of truth. Read it top to bottom before writing code. It carries the vision, the industry context, the architecture, the per-stage specs, the data models, the quality bar, the foreseeable risks, and an ordered build plan with acceptance criteria. Where it says **VERIFY**, confirm the detail against the named external docs before coding (do not guess SDK or model APIs).
>
> Business context lives in `docs/PRD.md`; pipeline overview in `docs/PIPELINE.md`. This document supersedes them where they conflict on build detail.

---

## 0. How to use this document

- **Goal:** build the Jantra AI planning pipeline so it is the best in the world at turning a raw idea into a researched, validated, fully-planned product spec.
- **Scope right now:** three pipeline stages — **Intake → Research → Planning** — on the existing runtime. Stage 4 (Build) is explicitly out of scope (see §15).
- **Models:** Google **Gemini 2.5** only (Flash or Pro), selectable per stage. No Claude/Anthropic in the runtime. The current code still calls Anthropic; replacing that model layer is build task #1 (§13, Milestone 1).
- **Definition of done** for each milestone is in §13. Global acceptance criteria in §14.
- **Non-negotiables:** every model action is audited with its reasoning; risky actions pass a guardrail gate; humans confirm between stages; every research claim is traceable to a real source; every stage self-verifies before it is accepted.

---

## 1. Vision and mission

**Mission.** Take any product idea and return a researched, validated, build-ready plan that a competent team (human or agent) can execute with confidence — faster than a consultancy, deeper than a template, and fully traceable.

**Why this can be the best in the world.** The market already has fast PRD generators (ChatPRD, Keeborg, Figma Make) that emit a document in ~90 seconds. They are shallow, one-shot, and ungrounded: they pattern-match a template onto your prompt. The category is commoditizing at the "fast and shallow" end. Jantra wins at the opposite end:

1. **Research-grounded, not invented.** Every market claim is backed by a real source that was actually retrieved and verified. The plan is defensible, not plausible-sounding.
2. **Verification-centric, not one-shot.** Each stage runs a generate → critique → refine loop against an explicit rubric before its output is accepted. We optimize for being right, not for being first.
3. **Trustworthy and auditable.** Every action and the reasoning behind it is logged and traceable. A client can see exactly how a conclusion was reached. This is the durable moat: trust compounds, speed does not.
4. **Human-gated.** A person confirms each stage before the next runs. The system is a force multiplier for judgment, not a replacement that quietly ships nonsense.

The bet: as idea→spec generation commoditizes, the winners will be the systems people *trust* with real decisions. Trust is built from grounding, verification, and transparency. That is what we build.

**North-star quality statement.** A Jantra plan should be good enough that a skeptical investor or a senior engineer reads it and says "this is genuinely researched and thought through," not "this is AI filler."

---

## 2. Product overview

Jantra is a reusable agent **runtime** plus a **pipeline** built on it.

- **Runtime** (exists today): a manual agentic tool-use loop with a policy/guardrail gate, an append-only audit trail, human handoff, and prompt/context caching. One engine, many agents.
- **Pipeline** (this build): a 3-stage flow where each stage is an agent on the runtime, with a human confirmation gate between stages.

```
  ┌────────┐  gate  ┌──────────┐  gate  ┌──────────┐      ┌─ deferred ─┐
  │ Intake │ ─────► │ Research │ ─────► │ Planning │ ····►│   Build    │
  └────────┘        └──────────┘        └──────────┘      └────────────┘
   idea summary     cited market         PRD + TRD +       (out of scope)
                    research report       build plan
```

Unit of work = a **Project** (one idea / one engagement), scoped by `clientId` (single-tenant now: `clientId = "xolver"`, but every record carries the field so multi-tenant is a later feature, not a rewrite).

First user: Xolver itself (dogfood). The pipeline plans Xolver's own client ideas, then becomes the reference product.

---

## 3. Industry context and what we adopt from the leaders

This section exists so the builder understands *why* the architecture looks the way it does. Each pattern below is drawn from how the current best agentic systems actually operate, and is mapped to a concrete requirement in this build. Sources in §16.

| Leader / source | What they do | What Jantra adopts |
|---|---|---|
| **Anthropic — agent patterns** | Prompt chaining, routing, parallelization, **orchestrator-workers**, **evaluator-optimizer** | The pipeline is prompt-chaining of stages; Research uses orchestrator-workers (a planner spawns parallel search workers); every stage uses evaluator-optimizer (generate → critique → refine). |
| **Sierra — "constellation of models" + supervisors** | Multiple specialized models; supervisory agents enforce guardrails; post-turn and post-conversation defect review (fast high-recall + slow high-precision) | Each stage has a **critic/supervisor** pass separate from the generator. A cheap fast check plus a deeper check before an artifact is accepted. |
| **Decagon — layered guardrails** | Guardrails before, during, and after each interaction, run by **separate** models; a pre-production **eval suite** | The guardrail gate runs pre-action, in-parallel, and pre-delivery checks. A standing **eval harness** runs before any prompt or model change ships (§8.7). |
| **Deep research agents** (Gemini DR, WebThinker, LangChain deep agents) | Section-aware decomposition; a **source registry** recording every URL actually retrieved; **deterministic citation verification**; rubric scoring (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) | Stage 2 is built exactly this way: plan sections → fan out searches → register every source → write claims with citations → verify every citation against the registry → score against the rubric. |
| **Manus / Devin** | Multi-agent (planner, executor, retriever, verifier); dynamic re-planning when blocked | Research and Planning each separate the planner, the worker(s), and the verifier. Stages can re-plan within their step budget if verification fails. |
| **Memory / context engineering (2026)** | Memory vs context distinction; context compaction (large token savings); prompt caching (41–80% cost cut); short-term vs long-term layers; purposeful retrieval | Prior-stage artifacts are the pipeline's memory. Long Research runs use context compaction. Caching is on by default. Stages read only the artifacts they need, not the whole history. |
| **Guardrail tooling (2026)** | Prompt-injection detection, PII redaction, hallucination checks (cheap model is fine), topic restriction, audit trails, 200–300ms budgets | The guardrail gate covers all of these. Critically: **web content fetched during Research is untrusted input** and must be treated as a prompt-injection surface (§8.3, §12). |

**The strategic reading:** the leaders converge on a few things — separate the generator from the critic, ground claims in verifiable sources, layer guardrails, and run standing evals. Jantra is opinionated about all four. That is what makes it best-in-class rather than another wrapper.

---

## 4. Design principles (the rules the code must embody)

1. **Generator ≠ critic.** No stage accepts its own first draft. A separate critic pass (different prompt, optionally different model) scores it against a rubric; refine until it passes or the step budget is hit.
2. **Ground or abstain.** Research never states a market fact without a registered, verified source. If it cannot verify, it flags the claim as unverified rather than asserting it.
3. **Everything is auditable.** Thinking, messages, tool calls, policy decisions, approvals, citations, eval scores, handoffs — all written to the audit trail with timestamps and the run/project id.
4. **Fail closed.** When unsure, blocked, or unverifiable, stop and hand off to a human with full context. Never paper over a gap.
5. **Untrusted web content is hostile until proven otherwise.** Fetched pages can contain prompt-injection. Quote and cite them; never let them issue instructions to the agent.
6. **One engine, many agents.** Stages differ only in prompt, tools, model selection, and rubric. Shared mechanics live in the runtime, never copy-pasted per stage.
7. **Model is a config choice, behind an interface.** No stage imports a vendor SDK directly. All model calls go through one provider interface so Flash/Pro selection (and any future provider) is config, not code surgery.
8. **Cost is observed, not guessed.** Every model call records tokens and estimated cost to the audit trail and a per-project cost rollup.
9. **Deterministic where possible.** Citation verification, gate transitions, schema validation, and persistence are plain code, not model calls. Use the model for judgment, not for bookkeeping.
10. **Idempotent and resumable.** A crashed run can resume from the last completed stage without losing artifacts or the audit trail.

---

## 5. System architecture

```
            Trigger (CLI now; webhook/API later)
                          │
        ┌─────────────────▼─────────────────────────┐
        │  Orchestrator (pipeline控制, gates, state)  │   ← plain TypeScript, deterministic
        └───────┬───────────────────┬────────────────┘
                │ runs a stage       │ persists state + artifacts
                ▼                    ▼
        ┌───────────────┐     ┌──────────────┐
        │  Stage agent  │     │   Store      │ (projects, stages, artifacts, sources)
        │ (Intake /     │     └──────────────┘
        │  Research /   │
        │  Planning)    │
        └───┬───────┬───┘
            │       │
   ┌────────▼──┐ ┌──▼──────────────┐
   │ Model     │ │ Runtime services│
   │ provider  │ │ - audit         │
   │ (Gemini   │ │ - guardrail gate│
   │  Flash/   │ │ - human gate    │
   │  Pro)     │ │ - cost/telemetry│
   └────┬──────┘ │ - eval harness  │
        │        └─────────────────┘
        ▼
   Gemini 2.5 API  +  Google Search grounding
```

**Layering rules:**
- The **orchestrator** is deterministic: it sequences stages, enforces gates, persists state. It contains no model calls.
- A **stage agent** is the only place that calls the model. It uses the provider interface and the runtime services.
- **Runtime services** (audit, guardrail, human gate, cost, eval) are shared and stage-agnostic.
- The **provider** is the only module that knows about Gemini.

---

## 6. Tech stack and conventions

- **Language/runtime:** TypeScript (strict), Node ≥ 20, ESM. Keep the existing `tsconfig.json` settings (`strict`, `noUncheckedIndexedAccess`).
- **Model SDK:** Google Gen AI SDK for TypeScript, package **`@google/genai`** (**VERIFY** exact package name, version, and import surface at https://ai.google.dev/gemini-api/docs and the SDK repo before coding). Do not reuse `@anthropic-ai/sdk` for model calls once Milestone 1 lands.
- **Validation:** use a schema library (Zod recommended) for all structured model outputs and all artifact schemas. Validate every model JSON before trusting it.
- **No new heavy frameworks** without a reason. The runtime is intentionally small and legible.
- **File layout** (extend, do not restructure what exists):

```
src/
  config.ts                 runtime config (models per stage, keys, limits)
  audit.ts                  append-only audit trail (exists)
  policy.ts                 guardrail gate (exists; extend per §8.3)
  handoff.ts                human handoff sink (exists)
  types.ts                  shared domain types (exists)
  model/
    provider.ts             ModelProvider interface (NEW)
    gemini.ts               Gemini implementation (NEW)
    index.ts                provider factory: pick Flash/Pro per stage (NEW)
  runtime/
    evaluator.ts            generate→critique→refine loop (NEW)
    telemetry.ts            cost + token + latency rollup (NEW)
    evals/                  standing eval harness + datasets (NEW)
  pipeline/
    types.ts                Project/Stage/Artifact (exists; extend)
    store.ts                persistence (exists; extend per §8.4)
    orchestrator.ts         stage sequencing + gates (exists; extend)
    cli.ts                  pipeline runner (exists; extend)
    stages/
      intake.ts             Stage 1 (exists; port to provider)
      research.ts           Stage 2 (NEW)
      planning.ts           Stage 3 (NEW)
  agents/support/           reference support agent (exists; port to provider)
docs/                       PRD, PIPELINE, this BUILD_SPEC
```

- **Naming/comments:** match the existing style. Comments explain *why*, not *what*. No em dashes in user-facing copy (brand rule).
- **Errors:** typed, surfaced, logged to audit. Never swallow. A failed model call retries with backoff, then fails the stage cleanly (artifact not produced, stage left in a recoverable state).

---

## 7. Model layer (Gemini 2.5, selectable per stage)

### 7.1 Provider interface

Define one interface that every stage uses. It hides Gemini entirely.

```ts
// src/model/provider.ts
export interface ModelMessage { role: "user" | "model" | "system"; content: string }

export interface GenerateOptions {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];              // function declarations
  responseSchema?: object;        // for structured JSON output
  grounding?: boolean;            // enable Google Search grounding (Research)
  thinking?: boolean;             // enable Gemini thinking; capture for audit
  maxOutputTokens?: number;
  // caching handled inside the implementation
}

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  thinking?: string;              // reasoning summary, for the audit trail
  citations?: GroundingCitation[];// when grounding is on
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  costUsd: number;               // computed from usage + price table
}

export interface ModelProvider {
  readonly id: string;            // e.g. "gemini-2.5-flash"
  generate(opts: GenerateOptions): Promise<ModelResult>;
}
```

### 7.2 Gemini implementation (`src/model/gemini.ts`)

**VERIFY all of the following against Google's official Gemini API docs before coding** (https://ai.google.dev/gemini-api/docs): exact model ID strings, the function-calling request/response shape, structured-output config, grounding (Google Search) config and how citations are returned, the thinking config and how thinking text is exposed, and context caching. Do not guess these.

- Model IDs (as of research, **confirm**): `gemini-2.5-flash`, `gemini-2.5-pro`. (`gemini-2.5-flash-lite` exists but is not used in the pipeline; see §4 — value-dense work does not go on Lite.)
- **Function calling:** map `ToolSpec` to Gemini function declarations; parse tool calls from the response. Always parse JSON, never string-match.
- **Structured output:** when `responseSchema` is set, use Gemini's structured-output/JSON mode and validate the result with Zod. On invalid JSON, retry once, then fail the stage.
- **Grounding:** when `grounding: true`, enable Google Search grounding and capture the returned citations into `ModelResult.citations`. Used by Research.
- **Thinking:** when `thinking: true`, enable the model's thinking and capture a reasoning summary into `ModelResult.thinking` so the audit trail records the "why."
- **Caching:** use Gemini context caching for the stable prefix (system prompt + fixed instructions) to cut cost. Keep the prefix byte-stable; put volatile content last.
- **Cost:** maintain a price table (input/output/cached per 1M tokens for Flash and Pro; **VERIFY current Google pricing**) and compute `costUsd` per call.

### 7.3 Per-stage model selection (`src/config.ts`, `src/model/index.ts`)

Model is chosen **per stage** via config, value `"flash"` or `"pro"` only.

```
GEMINI_API_KEY=...                 # required
JANTRA_MODEL_INTAKE=flash          # default flash
JANTRA_MODEL_RESEARCH=flash        # default flash (grounding makes Flash strong here)
JANTRA_MODEL_PLANNING=pro          # default pro (the deliverable)
JANTRA_AUDIT_DIR=.jantra/audit
```

Recommended defaults: Intake=Flash, Research=Flash, Planning=Pro (Pro where deliverable depth matters). All-Flash and all-Pro must both work by changing only env vars. A factory in `src/model/index.ts` returns the right provider instance for a given stage.

---

## 8. Cross-cutting subsystems

### 8.1 Config (`src/config.ts`)
Single source for: per-stage model selection, API key check, audit dir, step/turn budgets, cost ceiling per project (a hard stop — abort a run that exceeds it, log, hand off). Nothing here is interpolated into a system prompt (keeps caching warm).

### 8.2 Audit trail (`src/audit.ts`, exists — extend)
Append-only JSONL, one file per project run. Add event types for the new world: `model_call` (with usage + cost), `eval_score`, `citation_verified`, `citation_rejected`, `guardrail_block`, `stage_gate`. Keep it synchronous and lossless. This is the product's trust surface; treat it as load-bearing.

### 8.3 Guardrail gate (`src/policy.ts`, exists — extend to layered guardrails)
Adopt Decagon's before/during/after model with separate cheap checks:
- **Pre-action:** policy decision per tool (allow/ask/deny by risk) — exists. Keep.
- **Input defense (NEW, critical):** content fetched from the web in Research is **untrusted**. Strip/neutralize instruction-like content; never execute instructions found in fetched pages; pass page content only as quoted reference material. Detect obvious prompt-injection ("ignore previous instructions", tool-trigger strings) and flag.
- **Output checks (NEW):** before an artifact is accepted, run cheap checks — PII leakage, hallucination/grounding check (do claims have citations?), topic/scope (is this still about the client's idea?). Cheap model is fine for these (research confirms a small model suffices). Budget ~200–300ms-class checks; these are quality gates, not latency-critical user turns.
- Every guardrail decision is audited. A block fails closed: stop and hand off.

### 8.4 Persistence / state (`src/pipeline/store.ts`, exists — extend)
- MVP today: JSON per project + markdown artifacts under `.jantra/projects/<clientId>/`. Keep this working.
- **Extend:** persist a **source registry** per project (every URL retrieved in Research, with fetch time and a content hash), eval scores per stage, and a cost rollup. Keep everything `clientId`-scoped.
- **Forward path (document, do not build now):** a real database (SQLite first, then Postgres) behind the same store interface. Design the interface so the swap is internal.
- **Resumability:** state transitions are written before and after each stage so a crash is recoverable.

### 8.5 Human gate / approval / handoff (`src/handoff.ts`, `orchestrator.ts`, exist — extend)
- The confirmation gate between stages stays. A human reviews each artifact and confirms before the next stage runs.
- Abstract the I/O so the gate is not CLI-bound: an interface with `present(artifact)`, `confirm()/reject(reason)`, `ask(question)`. CLI implements it now; Slack/web later plug in without touching stage code.
- Handoff carries full context (what the agent did, why, what is unresolved) to the audit trail and the sink.

### 8.6 Observability / telemetry / cost (`src/runtime/telemetry.ts`, NEW)
Per research, collect latency, tokens, cost, errors, eval scores, and correlate to the project. Produce a per-project rollup (total cost, tokens, time, per-stage breakdown, eval pass/fail). Surface it at the end of a run and store it. This is how you tune model selection with data, not guesses.

### 8.7 Eval harness (`src/runtime/evals/`, NEW — do not skip)
Every leader runs standing evals before shipping prompt/model changes. Build a small but real harness:
- A set of **fixture ideas** (seed inputs) with expected properties.
- Per-stage **rubrics** (see §11) scored by an LLM judge plus deterministic checks (e.g., does every research claim have a verified citation? does the PRD contain all required sections?).
- A command (`npm run eval`) that runs the pipeline (or a stage) over fixtures and reports scores, so a prompt tweak that regresses quality is caught before it ships.
- Treat eval coverage as part of definition-of-done for each stage.

---

## 9. The pipeline — detailed stage specs

Each stage: takes the confirmed prior artifact(s), runs a generate→verify loop, produces a versioned artifact, leaves the stage `awaiting_confirmation` at the gate. Each stage records thinking, model calls, costs, and eval scores to the audit trail.

### 9.1 Stage 1 — Intake (exists; port to provider + add critic)
**Purpose:** draw out the idea via focused clarifying questions, then emit a structured **idea summary**.
**Build tasks:**
- Port the existing multi-turn intake from the Anthropic SDK to the provider interface (Gemini Flash default).
- Keep the `submit_idea_summary` function-call finalization.
- **Add a critic pass:** before accepting, a separate check asks "is this summary specific enough for research and planning? what is missing?" If weak, ask one or two more questions or note open questions. Audit the critique.
**Artifact:** `idea_summary` (markdown + structured fields: title, problem, solution, target users, key features, constraints, success criteria, open questions).
**Done when:** a vague idea reliably becomes a specific, structured summary; the critic catches under-specified summaries; everything audited.

### 9.2 Stage 2 — Research (NEW — built like a deep-research agent)
**Purpose:** produce a **cited market research report** that validates (or challenges) the idea: market, competitors, audience, differentiation, risks, demand signals. This is where "grounded, not invented" is won.

**Architecture (orchestrator-workers + verification-centric):**
1. **Plan:** from the idea summary, generate a research plan as a set of sections/questions (e.g., market size & trends, competitors, target users, pricing norms, risks, demand evidence). Section-aware decomposition.
2. **Fan out search workers:** for each section, run grounded searches (Gemini + Google Search grounding) and/or explicit web fetch. Workers can run in parallel within a concurrency cap.
3. **Source registry:** record **every** source actually retrieved (URL, title, fetch time, content hash) in the project store. This is ground truth.
4. **Synthesize per section:** write each section's findings as discrete claims, each claim attached to one or more registered sources. Untrusted-content rules apply (§8.3).
5. **Deterministic citation verification:** post-process every claim — its citation must resolve to a source in the registry that was actually retrieved. Unresolved citations are rejected; the claim is dropped or marked unverified. This is plain code, not a model call.
6. **Critic/verifier pass:** score the report against the Research rubric (§11). If it fails (thin coverage, unsupported claims, weak sources), re-plan and run another round within the step/cost budget.
7. **Assemble** the final report with a sources appendix.

**Tools:** grounded generation, web fetch, the source registry (write/lookup).
**Artifact:** `research_report` (markdown, sectioned, every claim cited, sources appendix) + the persisted source registry.
**Foreseeable failure modes to handle:** hallucinated citations (caught by step 5), prompt injection from pages (§8.3), thin/low-quality sources (rubric penalizes; verifier triggers another round), runaway cost (project cost ceiling, §8.1).
**Done when:** for a real idea, the report is sectioned, every market claim resolves to a retrieved source, weak sources are flagged, and the verifier rejects ungrounded drafts.

### 9.3 Stage 3 — Planning (NEW — the deliverable; Pro by default)
**Purpose:** turn the confirmed idea + research into the build-ready plan: **PRD**, **TRD**, and a **build plan**. This is what the client pays for; quality bar is highest.

**Architecture (evaluator-optimizer):**
1. **Generate** the PRD from idea + research (problem, users, goals/non-goals, scope, functional + non-functional requirements, success metrics, risks). Pull real constraints and market facts from the research, cited where relevant.
2. **Generate** the TRD from the PRD (architecture, data model, key components, integrations, tech choices with rationale, security/privacy, scalability, open technical questions). Demands real technical judgment — Pro by default.
3. **Generate** the build plan (phased milestones, sequencing, acceptance criteria per milestone, risks). This is the document that could later feed a Build stage.
4. **Critic pass per document** against the Planning rubric (§11): completeness, internal consistency, grounding in the research, technical soundness, actionability. Refine until it passes or budget hit.
5. **Cross-document consistency check:** the TRD must serve the PRD; the build plan must cover the PRD scope. A deterministic + LLM check that the three agree.

**Artifacts:** `prd`, `trd`, `build_plan` (markdown). 
**Done when:** the three documents are coherent with each other, grounded in the research (not generic), pass the rubric, and read as genuinely thought-through rather than templated.

### 9.4 The gate (exists — keep)
After each stage, set `awaiting_confirmation`, present the artifact, and wait for human confirm/reject. On reject with feedback, the stage can re-run incorporating the feedback. On confirm, advance. Build stage stays registered but disabled (returns "out of scope").

---

## 10. Data models (build to these; refine names as needed)

```ts
type StageId = "intake" | "research" | "planning"; // "build" registered but disabled
type StageStatus = "pending" | "in_progress" | "awaiting_confirmation" | "confirmed" | "rejected" | "skipped";

interface Source {
  id: string;
  url: string;
  title: string;
  retrievedAt: string;
  contentHash: string;       // ground truth that it was actually fetched
}

interface Claim {
  text: string;
  sourceIds: string[];       // must resolve to registered Sources
  verified: boolean;
}

interface EvalScore {
  rubric: string;
  scores: Record<string, number>;   // per-criterion
  passed: boolean;
  notes: string;
}

interface Artifact {
  stage: StageId;
  kind: "idea_summary" | "research_report" | "prd" | "trd" | "build_plan";
  title: string;
  content: string;           // markdown
  version: number;
  createdAt: string;
  eval?: EvalScore;
}

interface StageState {
  id: StageId;
  status: StageStatus;
  artifacts: Artifact[];
  updatedAt: string;
}

interface CostRollup {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  perStage: Record<StageId, { usd: number; inputTokens: number; outputTokens: number }>;
}

interface Project {
  id: string;
  title: string;
  clientId: string;          // "xolver" for now; multi-tenant-ready
  status: "active" | "completed" | "abandoned";
  currentStage: StageId;
  stages: Record<StageId, StageState>;
  sources: Source[];         // the project source registry (Research)
  cost: CostRollup;
  createdAt: string;
  updatedAt: string;
}
```

---

## 11. Quality and verification strategy (rubrics)

Each stage is scored before acceptance. Rubrics live with the eval harness and are reused by the in-run critic and the standing evals. Adapt the deep-research rubric principles: atomicity, verifiability, unambiguity, independence, alignment.

- **Intake rubric:** specificity (is the problem concrete?), completeness (problem/users/solution/constraints/success all present?), researchability (could a researcher act on this?), no invented details.
- **Research rubric:** factual accuracy, **citation accuracy (every claim resolves to a retrieved source)**, completeness (all planned sections covered), source quality (credible, recent, diverse), and balance (does it surface risks, not just confirmation?).
- **Planning rubric:** completeness (all required sections), internal consistency (PRD/TRD/build plan agree), grounding (uses the research, not generic boilerplate), technical soundness, actionability (could a team execute it?).

A stage that cannot pass its rubric within budget hands off to a human rather than shipping a weak artifact (fail closed).

---

## 12. Foresight — risks in this business and how the build pre-empts them

The user asked for foresight. These are the real risks of an idea→plan agentic business, and what in the build addresses each.

1. **Commoditization at the shallow end.** ChatPRD/Keeborg/Figma generate specs in seconds. *Mitigation:* compete on grounding + verification + trust + depth (§1). The build's verification-centric design *is* the moat. Do not race them to "fastest template."
2. **Hallucinated facts create liability.** A confidently wrong market claim in a paid plan is a reputational and legal risk. *Mitigation:* deterministic citation verification (§9.2 step 5), ground-or-abstain (§4.2), output hallucination checks (§8.3).
3. **Prompt injection via researched web pages.** Research ingests untrusted content; a malicious page could try to hijack the agent. *Mitigation:* untrusted-content handling (§4.5, §8.3) — fetched content is quoted reference only, never instructions.
4. **Confidentiality of client ideas.** Clients hand over their unbuilt product ideas. A leak is fatal to trust. *Mitigation:* `clientId` isolation from day one; no secrets/PII in prompts or logs beyond what is needed; redaction in audit where required; document a data-handling policy. Single-tenant now; per-client isolation available later.
5. **Cost runaway on deep research.** Long search loops can spiral. *Mitigation:* per-project cost ceiling (hard stop), per-stage step/round budgets, cheap model for checks, caching, telemetry to spot drift.
6. **Model dependency / lock-in / deprecation.** Gemini model IDs and pricing change; a model can be retired. *Mitigation:* the provider interface (§7.1) isolates the vendor; switching model or provider is config + one module. Keep the price table and model IDs in one place.
7. **Quality inconsistency run-to-run.** Agentic output varies. *Mitigation:* rubrics + critic passes + standing evals catch regressions; the human gate is the backstop. This is also why we keep humans in the loop, not removed.
8. **Eval debt.** Teams skip evals and quality silently rots. *Mitigation:* evals are part of definition-of-done (§8.7, §14); no prompt/model change ships without running them.
9. **Over-automation erodes trust.** If it quietly ships nonsense, clients stop trusting it. *Mitigation:* human-gated stages, full auditability, abstain-when-unsure. Trust is the product.
10. **Scaling beyond single-tenant.** Today it is one client. *Mitigation:* `clientId` on every record now; store interface ready for a real DB; document the multi-tenant path (do not build yet).
11. **Regulatory / IP drift.** AI-generated plans and researched content raise IP and disclosure questions. *Mitigation:* cite sources (provenance), keep the audit trail, flag where content is AI-synthesized vs sourced. Revisit formally before external launch.
12. **The "agentic shift" raises the bar fast.** Competitors are moving copilot → agentic (research confirms). *Mitigation:* Jantra is agentic and verification-centric from the start; the runtime + eval harness let us improve quickly without rewrites.

---

## 13. Build sequence for Codex (ordered milestones)

Each milestone is independently shippable and ends with passing typecheck and its own checks. Do them in order.

**Milestone 1 — Gemini model layer.**
- Build `src/model/{provider.ts, gemini.ts, index.ts}`. **VERIFY** Gemini SDK/API first.
- Add per-stage model config + `GEMINI_API_KEY` to `config.ts`; remove Anthropic defaults.
- Port Stage 1 Intake and the reference support agent to the provider interface.
- *Done:* Intake runs end-to-end on Gemini Flash; typecheck clean; a real intake conversation produces a valid idea summary; model calls audited with tokens/cost.

**Milestone 2 — Runtime services.**
- `runtime/telemetry.ts` (cost/token/latency rollup), `runtime/evaluator.ts` (generate→critique→refine), extend `audit.ts` event types, extend `policy.ts` with output checks + untrusted-content handling.
- *Done:* a stage can run a critic pass and record an eval score + cost rollup.

**Milestone 3 — Stage 2 Research.**
- `pipeline/stages/research.ts` per §9.2: plan → grounded search workers → source registry → cited synthesis → deterministic citation verification → verifier loop.
- Extend `store.ts` for the source registry.
- *Done:* a real idea yields a sectioned, fully-cited report; every citation resolves to a retrieved source; ungrounded drafts are rejected; gate works.

**Milestone 4 — Stage 3 Planning.**
- `pipeline/stages/planning.ts` per §9.3: PRD → TRD → build plan with evaluator-optimizer + cross-document consistency, Pro by default.
- *Done:* coherent, research-grounded PRD/TRD/build plan that pass the Planning rubric; gate works; full pipeline runs Intake → Research → Planning end-to-end.

**Milestone 5 — Eval harness + hardening.**
- `runtime/evals/` with fixtures, rubrics, `npm run eval`; SQLite-backed store behind the existing interface; resumability; cost-ceiling enforcement.
- *Done:* `npm run eval` reports per-stage scores over fixtures; a crashed run resumes; exceeding the cost ceiling aborts cleanly with a handoff.

---

## 14. Global definition of done

- `npm run typecheck` passes; no `any` leaks across module boundaries; structured model outputs validated with a schema.
- Every model call goes through the provider interface; no vendor SDK imported in a stage.
- Every action + reasoning audited; every research claim has a verified citation or is marked unverified.
- Every stage has a rubric, a critic pass, and eval-harness coverage.
- Per-project cost rollup produced and a cost ceiling enforced.
- Human gate between every stage; fail-closed handoff on uncertainty.
- Secrets/keys never in prompts, logs, or artifacts. `clientId` on every record.
- README + this spec updated if the design changes during build.

---

## 15. Out of scope (do not build now)

- **Stage 4 (Build / code generation).** Registered as a disabled stage only.
- **Multi-tenant infrastructure**, auth, billing, web/Slack UI (keep the gate I/O abstracted so they slot in later).
- **A real database deployment** beyond the SQLite step in Milestone 5 (Postgres etc. later).
- **Any non-Gemini model provider** (interface should allow it; do not implement another).
- **Fine-tuning / custom models.** Use Gemini 2.5 as-is.

---

## 16. References (industry sources used to shape this spec)

- Anthropic, *Building Effective AI Agents* — agent patterns (orchestrator-workers, evaluator-optimizer): https://resources.anthropic.com/building-effective-ai-agents
- Sierra, *Constellation of models* and *enterprise-grade agents* (supervisors, defect review): https://sierra.ai/blog/constellation-of-models , https://sierra.ai/blog/enterprise-grade-agents
- Decagon, *Designing layered guardrails for reliable AI agents*: https://decagon.ai/blog/designing-layered-guardrails-for-reliable-ai-agents
- Deep research agent architectures (source registry, deterministic citation verification, rubrics): https://zylos.ai/research/2026-04-21-deep-research-agent-architectures , https://arxiv.org/html/2506.18096v1 , https://docs.langchain.com/oss/python/deepagents/deep-research
- Gemini 2.5 (function calling, grounding, structured output): https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash , https://ai.google.dev/gemini-api/docs/structured-output
- Agentic observability / guardrails (2026): https://www.arthur.ai/column/agentic-ai-observability-playbook-2026 , https://galileo.ai/blog/best-ai-agent-guardrails-solutions
- Context engineering / memory (compaction, caching, ACE): https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026
- Competitor landscape (idea→PRD): https://www.chatprd.ai/ , https://www.keeborg.com/blog/ai-prd-tools-compared-2026

> Model IDs, SDK signatures, and pricing in this document are directional and were current at research time (June 2026). **VERIFY** each against the official Google Gemini API docs before implementing. Do not guess an API.

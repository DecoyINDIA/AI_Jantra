# Jantra AI — Application & Platform Plan

> Status: **planning only**. This document is a specification to hand to Codex. No
> application code is changed by this document. Codex should read it, verify the
> open questions, refine where needed, then build in the milestone order below.
>
> Scope of this plan: the **application layer** that wraps the existing runtime —
> a config-driven (agent-agnostic) engine, a local API spine, a panel UI, a
> Windows desktop app, and the embedding path. It sits **on top of** the runtime
> work tracked in `docs/IMPLEMENTATION_PLAN.md` (Gemini migration, Milestones
> 1–5) and `docs/BUILD_SPEC.md`. It does not replace them.

---

## 1. Objective (in the owner's words)

Build the agent **once**, as a portable core, so it can then be used anywhere
with little or no change:

- Run it **locally** on a laptop/desktop today, inside one complete application
  with a **panel** to see and drive the agents. (Agents execute on that machine.)
- Later, **embed the same engine** in a website or in a third party's software —
  e.g. a research firm (like Xolver) whose only job is to produce planning and
  research **reports**, dropping these agents into their ERP or site.
- The panel must be able to drive **"anything and everything"** — not just the
  current planning pipeline. If an agent's **task changes**, its **operations
  change**, or its **output changes**, that must be a configuration change, not a
  re-architecture.

Two derived principles, taken as binding for this plan:

1. **One engine, many agents.** Agents are *data* (definitions), not hardcoded
   TypeScript. The planning pipeline is the *first* definition, not a special case.
2. **One product, multiple distributions.** The product is "panel UI + local
   API + engine." Desktop app and hosted web are two ways to *ship* it, not two
   codebases.

---

## 2. The core decision that dissolves "native vs web"

The owner was unsure whether to build a native app or a web app, and asked which
is cheaper **long term** for an SMB rollout. The answer is to not choose between
them at the architecture level:

> **Build a web-tech UI (React) that talks to a local HTTP API (the existing
> Node/TS runtime). Package that pair as a Windows desktop app with Electron now;
> serve the exact same pair as a hosted web app later. The desktop shell is thin
> and swappable.**

This gives, from **one codebase**:

- a **native Windows app** today (agents run locally on the machine), and
- a **hosted web app** later (SMB SaaS, zero rewrite), and
- an **embeddable API** for ERPs/websites (the engine is already a service).

### 2.1 Why Electron over Tauri (the long-term-cost call)

| Factor | Electron | Tauri |
|---|---|---|
| Runs the existing Node engine (`node:sqlite`, `@google/genai`) | **Natively, in the main process. Zero rewrite.** | Node must be bundled as a separate **sidecar** process; extra packaging + IPC fragility. |
| Languages/toolchains to maintain | **One (TypeScript end-to-end).** | Two (Rust shell + Node). |
| Auto-update / code-signing / installer maturity | **Mature, well-trodden** (`electron-updater`, `electron-builder`). | Good, but the sidecar complicates packaging. |
| Mac/Linux later | Free re-build. | Free re-build. |
| Installer size / RAM | Larger (~bundles Chromium). | Smaller, lighter. |

For a **back-office tool on a real business PC**, Tauri's only real wins (small
binary, low RAM) **do not matter**. Its costs (a second language and sidecar
packaging) are **recurring engineering time** — the scarce resource for a small
studio shipping to SMBs. **Electron minimizes total cost of ownership here.**

Crucially, this decision is **low-risk and reversible**: because the UI talks to
a **localhost API**, the desktop shell holds almost no logic. Swapping Electron →
Tauri later is *re-wrapping*, not *rewriting*. So we pick the cheapest-to-ship
option now without lock-in fear.

> If installer footprint ever becomes a sales objection from an SMB, revisit
> Tauri then — the migration cost is small by construction.

---

## 3. Target architecture

```
        ┌──────────────────────────────────────────────────────────────┐
        │  DISTRIBUTIONS (thin shells — hold almost no logic)            │
        │                                                                │
        │   Electron desktop (now)      Hosted web (later)   ERP/website │
        │   spawns local API +          serves same UI +     embed (later)│
        │   serves UI offline           API on a server                  │
        └───────────────┬───────────────────┬────────────────────┬──────┘
                        │   HTTP + SSE (the universal boundary)   │
                        ▼                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  PANEL UI  (React + Vite)   — one app, runs in shell or browser│
        │  agent catalog · run list · run detail · artifact viewer ·     │
        │  audit timeline · gate approve/reject · live stream · cost     │
        └───────────────────────────────┬──────────────────────────────┘
                                         │  calls /v1/* API
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  LOCAL API SPINE  (Fastify, Node)   — NEW, src/server/        │
        │  wraps the engine + store; clientId-scoped; SSE streaming     │
        └───────────────────────────────┬──────────────────────────────┘
                                         │  in-process calls
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  ENGINE (EMBEDDABLE CORE)  — existing src/, made agent-agnostic│
        │                                                                │
        │  AgentRegistry → AgentDefinition (agents as DATA)             │
        │  generic runner · policy gate · audit · handoff · evaluator   │
        │  ModelProvider (Gemini) · ProjectStore (SQLite/JSON/…)        │
        └──────────────────────────────────────────────────────────────┘
```

The **API spine is the universal boundary.** Everything above it (desktop,
hosted web, ERP embed) is a client. Everything below it is the portable engine.
This is what makes "build once, use anywhere" real.

> Note on the owner's phrasing "add the API at the end": the **local** API is the
> *spine* and must exist early (Milestone A2) — the panel has nothing to talk to
> without it. What is genuinely deferred to the **end** is the **remote
> exposure** of that same API (auth, tenancy, public embedding) — Milestone A5.

---

## 4. Current state (what we build on)

The engine is already well-factored for this, which keeps the refactor small:

| Concern | Where it lives today | Reusable as-is? |
|---|---|---|
| Single-shot agent loop (policy, approval, audit, handoff) | `src/agent.ts` (`Agent` class) | Yes |
| Agent definition (single-shot) | `src/types.ts` (`AgentSpec`, `ToolDef`) | Yes, extend |
| Model abstraction | `src/model/provider.ts` (`ModelProvider`) | Yes |
| Multi-stage pipeline runner + gate | `src/pipeline/orchestrator.ts` (`runStage`, `confirmStage`, `rejectStage`) | Yes, make generic |
| Pipeline data model | `src/pipeline/types.ts` (`Project`, `StageState`, `Artifact`) | Yes, extend |
| Persistence (interface + impls) | `src/pipeline/store.ts` (`ProjectStore`, `JsonProjectStore`), `src/pipeline/store/sqlite.ts` (`SqliteProjectStore`) | Yes |
| Audit (append-only JSONL) | `src/audit.ts` | Yes |
| Config / secrets / model choice | `src/config.ts` | Yes, extend |
| Entry points | `src/cli.ts`, `src/pipeline/cli.ts` | Keep; add API as a peer |

**The one structural blocker for "anything and everything":** the pipeline is
hardcoded to a fixed set of stages.

- `StageId = "intake" | "research" | "planning" | "build"` — a closed union
  (`src/pipeline/types.ts:4`).
- `STAGE_RUNNERS`, `ACTIVE_STAGE_ORDER`, `STAGE_TITLES`, `ArtifactKind`,
  `config.models` are all keyed to that fixed union.

To let agents' tasks/operations/outputs change without code edits, these must
become **properties of an agent definition**, resolved through a registry.

---

## 5. Agents as data — the `AgentDefinition` model (the heart of this plan)

This is the change that satisfies "the panel can drive anything, and changing the
task/output is configuration." We introduce a definition the engine, the API, and
the panel are all driven by.

### 5.1 Concept

An **agent** is an ordered list of **stages**. A stage is either:

- a **model-flow stage** — generate → critique → refine against a rubric,
  producing one or more typed artifacts (this is how Intake/Research/Planning
  work today); or
- a **tool-loop stage** — the `Agent` class loop with a tool set and policy
  (this is how the Support agent works today).

Each stage declares its **output schema** (so "if the output changes" = edit the
schema), its **tools + policy** (so "if the operations change" = edit those), its
**prompt** (so "if the task changes" = edit that), its **rubric**, and its
**gate** (human-confirm vs auto-advance).

### 5.2 Sketch (TypeScript — Codex to finalize against real types)

```ts
// src/agents/definition.ts  (NEW)
export interface StageDefinition {
  id: string;                       // was the StageId union member, now free string
  title: string;
  kind: "model-flow" | "tool-loop";
  model: StageModelChoice;          // "flash" | "pro" (per-stage, as today)
  promptTemplate: string;           // task — change this when the task changes
  tools?: AnyTool[];                // operations — change these when ops change
  policy?: Policy;                  // guardrails for this stage's tools
  outputSchema?: unknown;           // JSON schema — change when the output changes
  artifactKinds: string[];          // what this stage emits
  rubricId?: string;                // evaluator rubric
  gate: "human" | "auto";          // confirmation gate after the stage
}

export interface AgentDefinition {
  id: string;                       // "planning-pipeline", "support", ...
  name: string;
  description: string;
  version: number;                  // config versioning (PRD C4)
  stages: StageDefinition[];        // ordered; single-element list = single-shot agent
  clientScoped: true;               // always clientId-scoped
}
```

### 5.3 What changes in the engine

- `Project` gains `agentId: string` and `agentVersion: number` (which definition
  produced this run). `currentStage`/`stages` become keyed by the definition's
  stage ids (string), not the closed union.
- `StageId`/`ArtifactKind` unions in `src/pipeline/types.ts` relax to `string`
  (or `string & {}` branded), with the planning pipeline registered as a
  definition that happens to use `"intake" | "research" | "planning"`.
- `src/pipeline/orchestrator.ts` becomes generic over an `AgentDefinition`:
  `runStage(project, def, io)` looks up the runner by `stage.kind`, not by a
  hardcoded `STAGE_RUNNERS` map. `confirmStage`/`rejectStage` walk
  `def.stages` order instead of `ACTIVE_STAGE_ORDER`.
- `config.models` per-stage selection moves into each `StageDefinition.model`,
  with env overrides still honored (e.g. `JANTRA_MODEL_<AGENT>_<STAGE>`).
- A new **`AgentRegistry`** (`src/agents/registry.ts`) holds definitions and
  resolves them by id. Planning pipeline + Support agent are the first two
  entries.

### 5.4 What is deferred (deliberately)

- **No-code visual agent builder.** In this plan, definitions live in **code**
  (typed, version-controlled TS). They are *loaded through the registry*, so the
  engine, API, and panel are already definition-driven — but authoring a new
  agent still means writing a small definition file. Authoring definitions from
  the UI (definitions-as-DB-rows) is a later phase. This keeps the build
  tractable while making the long-term goal a data change, not a re-architecture.
  (Maps to PRD **C1** "define an agent without code edits" — staged.)

---

## 6. The local API spine (`src/server/`, NEW)

A Node HTTP server wrapping the engine + store. **Recommended: Fastify**
(schema-first, fast, first-class TypeScript, easy SSE). Express is an acceptable
fallback. All routes under `/v1`. Binds to `127.0.0.1` only in desktop mode.

### 6.1 Endpoints

| Method + path | Backed by | Purpose |
|---|---|---|
| `GET /v1/agents` | `AgentRegistry.list()` | Agent catalog for the panel |
| `GET /v1/agents/:agentId` | `AgentRegistry.get()` | One definition (stages, gates, schemas) |
| `POST /v1/runs` `{agentId, title, input}` | `createProject` + start | Start a run; returns `runId` |
| `GET /v1/runs?agentId=&status=` | `store.listProjects` | Run list |
| `GET /v1/runs/:runId` | `store.loadProject` | Run detail (stages, artifacts, cost, status) |
| `POST /v1/runs/:runId/advance` | `runStage` | Run the current stage |
| `POST /v1/runs/:runId/confirm` | `confirmStage` | Pass the human gate, advance |
| `POST /v1/runs/:runId/reject` `{reason}` | `rejectStage` | Reject current stage |
| `POST /v1/runs/:runId/interactions/:id` `{response}` | see §6.2 | Answer a question / approve a tool |
| `GET /v1/runs/:runId/artifacts/:kind` | store/files | Artifact content (markdown) |
| `GET /v1/runs/:runId/sources` | `project.sources` | Research source registry |
| `GET /v1/runs/:runId/audit?cursor=` | audit JSONL | Audit trail (paged) |
| `GET /v1/runs/:runId/events` (SSE) | audit + stage events | **Live** stream while a run executes |

### 6.2 The "interactive stage / approval over HTTP" problem (key design task)

Today, two things block on a synchronous terminal:

1. **`StageIO.ask`** — Intake is a multi-turn conversation via readline
   (`src/pipeline/cli.ts`).
2. **`onApproval`** — the policy `"ask"` path waits for a human at the terminal
   (`src/agent.ts:179`).

Over HTTP there is no blocking terminal. Both must become **pending
interactions**: the run pauses, persists a `PendingInteraction` on the project,
the API reports state `awaiting_input`, the panel renders it, the client POSTs a
response to `/interactions/:id`, and the run resumes.

```ts
export interface PendingInteraction {
  id: string;
  kind: "question" | "approval";   // StageIO.ask vs policy "ask"
  prompt: string;                  // question text or "Approve issue_refund?"
  toolName?: string;               // for approvals
  input?: unknown;                 // for approvals
  createdAt: string;
}
```

This **unifies** the three human touch-points — stage-confirm gates, in-stage
questions, and tool approvals — into one mechanism the panel resolves. It also
makes runs **resumable** (a run can sleep awaiting input and wake on POST), which
the desktop app needs anyway. `StageIO` is reimplemented over this queue for the
API; the CLI keeps its readline implementation.

### 6.3 Error & status model

- Typed errors from the engine (`StageFailedClosedError`, cost-ceiling, schema
  validation) map to structured HTTP errors `{ code, message, runId }`.
- Run states surfaced: `active | awaiting_input | awaiting_confirmation |
  completed | rejected | failed`.
- Fail-closed stays fail-closed: a failed stage returns the handoff context, it
  does not silently retry.

---

## 7. The panel UI (`web/`, NEW — React + Vite + TypeScript)

A single React app, served by the Electron shell (offline) now and by a web
server later. UI library: shadcn/ui + Tailwind (matches the in-house styling
skill; accessible, fast to build). State: TanStack Query against `/v1`.

### 7.1 Screens (all driven by the API, none hardcoded to the pipeline)

1. **Agent catalog** — cards from `GET /v1/agents`. "Start a run" per agent.
2. **Run list** — table from `GET /v1/runs`: agent, title, status, stage, cost,
   updated. Filter by agent/status.
3. **Run detail** — the core screen:
   - **Stage timeline** rendered from the agent definition's `stages` (generic,
     so a 1-stage or 7-stage agent both render correctly).
   - **Artifact viewer** — markdown render of each stage's artifacts.
   - **Gate controls** — Approve / Reject on `awaiting_confirmation`.
   - **Pending interaction** — question box or approve/deny on `awaiting_input`.
   - **Live progress** — subscribe to `/events` (SSE): thinking summaries, tool
     calls, policy decisions, eval scores stream in as the run executes. This is
     the "see everything it did, and why" product surface.
   - **Cost** — per-stage and total from `project.cost`.
4. **Audit view** — full append-only trail for a run (the trust artifact).
5. **Settings** — Gemini key entry (desktop: written to OS keychain, never to
   the renderer state), default model choices, cost ceiling.

### 7.2 Why generic rendering matters

Because every screen is driven by the **agent definition + run state from the
API**, adding or changing an agent (new stages, new output schema, new tools)
requires **no panel code change**. This is the concrete payoff of §5.

---

## 8. Desktop packaging (`desktop/`, NEW — Electron)

- **Main process** spawns/embeds the Fastify API on `127.0.0.1:<random free
  port>` and loads the built React UI from disk (offline-capable).
- **Secrets:** Gemini API key stored via OS-native secure storage
  (`safeStorage` / keychain), injected into the API process env at launch.
  **Never** placed in the renderer or in any prompt/log/artifact (consistent with
  the runtime's secret rules).
- **Storage:** `SqliteProjectStore` pointed at an OS-appropriate `userData`
  path; audit JSONL alongside it. (`ProjectStore` interface already supports
  this — only the path changes.)
- **First-run:** setup wizard — enter Gemini key, pick default models, done.
- **Lifecycle:** single-instance lock, system tray, graceful API shutdown,
  auto-update via `electron-updater`.
- **Build:** `electron-builder` → signed Windows installer (`.exe`/NSIS).
  Mac/Linux targets available later at near-zero marginal cost.

---

## 9. Embedding readiness — the "API at the end" (Milestone A5)

This is what lets a research firm drop these agents into their ERP or website.
The **same** Fastify API, exposed remotely with the guardrails a network needs:

- **Auth:** API keys (per integrator) and/or OAuth; every `/v1` call carries an
  identity that resolves to a `clientId`. No more implicit single-user.
- **Tenancy:** strict `clientId` filtering on every store query (the data model
  is already `clientId`-scoped — enforce it at the API edge). One tenant can
  never read another's runs.
- **Hardening:** CORS allowlist, rate limiting, request size limits, audit of
  API access itself.
- **Integration surfaces:**
  - a tiny **JS client SDK** (`@jantra/client`) wrapping `/v1`;
  - an **embeddable widget / iframe** for a read-mostly "agent runs" panel a
    partner can drop into their site;
  - **webhooks** so a partner's ERP is notified on run completion / gate.
- **White-label hooks:** name, logo, theme from config (the panel already themes
  via Tailwind tokens).

> Do **not** ship remote exposure without auth + tenancy. The moment `/v1` is
> reachable off `localhost`, those are mandatory, not optional.

---

## 10. Repository shape

Move to **npm workspaces** to keep the engine, API, UI, and shell as separable
units without splitting repos:

```
package.json                 # workspace root
src/                         # ENGINE — existing runtime (stays the engine package)
  agents/registry.ts         # NEW — AgentRegistry
  agents/definition.ts       # NEW — AgentDefinition / StageDefinition
  server/                    # NEW — Fastify API spine
web/                         # NEW — React + Vite panel
desktop/                     # NEW — Electron shell
docs/                        # plans (this file, IMPLEMENTATION_PLAN.md, …)
```

The engine stays importable as a library (the embeddable core). The API imports
the engine; the desktop shell spawns the API and serves `web/`. Keep TypeScript
strict, ESM, Node ≥ 20 throughout (consistent with current `package.json`).

---

## 11. Milestones (build order)

> Prerequisite: the runtime track in `docs/IMPLEMENTATION_PLAN.md` (Gemini
> migration M1–M2 at minimum) should be stable before A2, since the API streams
> real model runs. A1 (the refactor) can begin in parallel.

### A1 — Agent-agnostic core refactor
- **Create:** `src/agents/definition.ts`, `src/agents/registry.ts`.
- **Change:** `src/pipeline/types.ts` (relax `StageId`/`ArtifactKind`; add
  `agentId`/`agentVersion` to `Project`), `src/pipeline/orchestrator.ts` (generic
  over `AgentDefinition`), `src/config.ts` (per-definition model resolution),
  register the planning pipeline + Support agent as definitions.
- **Acceptance:** `npm run pipeline` still runs the planning pipeline end-to-end
  through the registry; Support agent resolves as a 1-stage definition; typecheck
  clean; no behavior change for existing users.
- **DoD:** stages/artifacts/models are owned by definitions; no hardcoded
  `STAGE_RUNNERS` map remains.

### A2 — Local API spine
- **Create:** `src/server/` (Fastify app, routes, SSE, error mapping),
  `PendingInteraction` model + HTTP-backed `StageIO`/approval queue.
- **Change:** orchestrator to support pause/resume on interactions; `package.json`
  add `npm run server`.
- **Acceptance:** full planning run drivable over HTTP with `curl` — create run,
  advance, answer an intake question, hit the gate, confirm, read artifacts +
  audit; `/events` streams live; clientId scoping enforced.
- **DoD:** no terminal blocking anywhere in the server path; runs resume after
  awaiting input.

### A3 — Panel UI
- **Create:** `web/` (Vite + React + shadcn/ui + TanStack Query); the screens in
  §7.
- **Acceptance:** every screen renders from the API; a run can be started,
  watched live, gated, and inspected entirely in the browser against the local
  API; adding a dummy second agent definition needs **zero** UI changes.
- **DoD:** generic rendering verified with two different-shaped agents.

### A4 — Electron desktop app
- **Create:** `desktop/` (Electron main, preload, builder config).
- **Acceptance:** one signed Windows installer; first-run key setup; agents run
  locally; data in `userData` SQLite; auto-update wired; key in OS keychain, not
  renderer.
- **DoD:** a clean Windows machine installs, sets a key, and completes a planning
  run offline (except Gemini calls).

### A5 — Embedding readiness (remote API)
- **Create:** auth + tenancy middleware, `@jantra/client` SDK, embeddable
  widget, webhooks.
- **Acceptance:** the API runs hosted with API-key auth; a sample external page
  starts a run and renders results via the SDK; cross-tenant access is provably
  blocked.
- **DoD:** no `/v1` route is reachable without an identity resolving to a
  `clientId`.

### A6 — SMB rollout hardening
- Code signing, crash/error telemetry, update channel, audit export/backup,
  installer docs, licensing/activation. **Acceptance:** a non-technical SMB user
  can install, activate, and run an agent from a single installer + one-page guide.

---

## 12. Security & trust (carried from the runtime, enforced at every new edge)

- Secrets never in renderer, prompts, logs, or artifacts; OS keychain on desktop,
  vault on host.
- Policy gate, approvals, and audit run **server-side** in the API — the client
  is never trusted to enforce them.
- Audit stays append-only; for hosted, mirror to the durable store.
- `clientId` on every record and every query (already true in the data model;
  enforce at the API edge in A5).
- Untrusted web content (Research) stays reference-only — unchanged by this plan.

---

## 13. Risks & open questions (for Codex to resolve before/while building)

1. **Interactive-stage refactor scope.** Converting `StageIO.ask` + `onApproval`
   to the async `PendingInteraction` queue (§6.2) is the largest single change.
   Confirm it cleanly covers Intake's multi-turn conversation without regressing
   the CLI. *Recommendation: build the queue first, reimplement CLI `StageIO` on
   top of it too, so there is one path.*
2. **Streaming granularity.** SSE from audit events vs a dedicated event bus —
   decide whether the panel reads the audit stream directly or a derived
   run-event stream. *Recommendation: a thin run-event projection over audit, so
   the audit format stays the product-of-record.*
3. **Definition versioning.** How a run pins to the `agentVersion` it started
   with when a definition changes mid-flight (PRD C4). *Recommendation: snapshot
   the definition id+version on the `Project` at creation.*
4. **Fastify vs Express.** Confirm Fastify SSE + schema validation ergonomics on
   Node ≥ 20. *Recommendation: Fastify unless a blocker appears.*
5. **Electron vs Tauri** — decided (Electron, §2.1). Re-open only if installer
   footprint becomes a real SMB objection.
6. **Workspace migration** — moving to npm workspaces touches `package.json`,
   `tsconfig`, and scripts. Sequence it at the start of A2 (first time a second
   package appears), not during A1.
7. **Hosted storage** — A5 needs a Postgres `ProjectStore` implementation behind
   the existing interface; confirm the interface covers listing/filtering at
   scale (pagination) before committing.

---

## 14. Explicitly deferred (not in this plan's build)

- No-code visual agent builder (definitions remain code in A1–A4; UI authoring is
  post-A5).
- Multi-user desktop (desktop stays single-user; multi-tenant is the hosted path,
  A5).
- Stage 4 (Build) of the pipeline — remains registered but disabled, unchanged.
- Mobile apps.

---

## 15. Definition of done (whole plan)

- The engine runs **any** registered agent definition; the planning pipeline is
  just the first one.
- A local **API** fully drives runs; the **panel** renders generically from it.
- A signed **Windows desktop app** runs agents locally with secrets in the OS
  keychain.
- The **same API** can be exposed remotely with auth + tenancy and embedded in a
  third party's ERP/website via SDK/widget.
- Changing an agent's **task, operations, or output** is a definition change —
  no engine, API, or panel rewrite.

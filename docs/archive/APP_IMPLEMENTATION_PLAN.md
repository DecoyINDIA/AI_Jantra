# Jantra AI Application Implementation Plan

Status: planning only. This document is the only artifact produced for this
step. Do not write application code until this plan is reviewed and approved.

## 1. Current-State Summary

### Product and runtime context

The application layer wraps the existing Jantra runtime and planning pipeline
with a universal `/v1` API, a panel UI, a Windows desktop shell, and an embedding
path. It must not weaken the runtime guarantees in `docs/BUILD_SPEC.md`:
Gemini-only provider calls, generator versus critic separation, deterministic
citation verification, fail-closed behavior, human gates, append-only audit,
cost rollup, and `clientId` scoping.

The runtime track is further along than `docs/APP_PLAN.md` assumed. The repo
already contains:

- `src/model/{provider.ts,gemini.ts,index.ts,mock.ts}` with Gemini and mock
  providers.
- `src/runtime/{evaluator.ts,telemetry.ts,errors.ts}` and
  `src/runtime/evals/*`.
- `src/pipeline/stages/{intake.ts,research.ts,planning.ts}`.
- `src/pipeline/store/sqlite.ts` using `node:sqlite`.
- `npm run eval`, `npm run smoke`, and Gemini-only package dependencies.

`npm.cmd run typecheck` passed during this planning pass.

### Current structural blockers

The application plan's core refactor is still needed. The pipeline remains
hardcoded to the planning stages:

- `src/pipeline/types.ts` has a closed
  `StageId = "intake" | "research" | "planning" | "build"` union.
- `ArtifactKind` is also a closed union.
- `ACTIVE_STAGE_ORDER`, `STAGE_TITLES`, `CostRollup.perStage`,
  `config.models`, `createProviderForStage(stage)`, and `emptyCostRollup()` are
  keyed by that closed stage union.
- `src/pipeline/orchestrator.ts` has a hardcoded `STAGE_RUNNERS` map and
  `confirmStage()` walks `ACTIVE_STAGE_ORDER`.
- `Project` does not yet carry `agentId`, `agentVersion`, or an agent definition
  snapshot.
- Intake and evaluator code still reaches into fixed keys such as
  `project.stages.intake`.
- Eval code also has fixed-stage assumptions in
  `src/runtime/evals/smoke.ts` and `src/runtime/evals/judge.ts`.
- `src/agent.ts` still accepts `onApproval` as a terminal-style async callback.
- `StageIO.ask` is implemented directly by the CLI in `src/pipeline/cli.ts`.
- `ProjectStore.listProjects(clientId): Project[]` has no pagination, filters,
  cursor, or summary shape.

### What each application milestone changes

- A1 turns the planning pipeline and support agent into registered
  `AgentDefinition`s. The public engine model changes from hardcoded `StageId`
  and `ArtifactKind` unions to definition-owned stage and artifact ids.
- A2a adds the local API spine, loopback auth, store query contract, and SSE
  happy path.
- A2b moves human interactions to a re-entrant pause/resume path that can serve
  the CLI and HTTP surfaces.
- A3 adds the panel UI, rendered from agent definitions and run state rather
  than hardcoded Intake, Research, and Planning screens.
- A4 packages the same API plus panel as a thin Electron desktop app.
- A5 exposes the same API remotely only after auth, tenancy, and identity to
  `clientId` resolution are enforced.
- A6 hardens the product for SMB rollout.

## 2. Verified Facts

### Interactive stage and approval refactor

Confirmed against current code:

- Intake uses `StageIO.ask` repeatedly inside `runIntake()` and keeps its model
  transcript in local function scope.
- Tool approval in `src/agent.ts` waits on `onApproval()` when policy returns
  `"ask"`.
- A simple persisted `PendingInteraction` queue is enough for in-process pause,
  but not for crash-safe HTTP resume. JavaScript cannot suspend and restore an
  async function stack across a process restart.
- Crash-safe resume requires re-authoring interactive stages as re-entrant
  runners. A re-entrant runner must rebuild model messages from persisted state
  and resume from `start()` or `resume()` based on the stored step, not from
  local variables.
- The CLI can share the same path by using a `CliInteractionAdapter` over the
  same interaction broker. The CLI may answer immediately via readline; the API
  adapter persists and returns `awaiting_input`.

Decision: keep the stronger crash-safe resume guarantee, but move it to A2b and
make the stage-authoring contract explicit. A2a only promises non-interactive
HTTP driving and live events. A2b changes interactive runners to this shape:

```ts
export interface ReentrantStageRunner {
  start(ctx: StageRunContext): Promise<StageRunStep>;
  resume(ctx: StageRunContext, response: InteractionResponse): Promise<StageRunStep>;
}

export type StageRunStep =
  | { status: "awaiting_input"; state: PersistedStageState; interaction: PendingInteraction }
  | { status: "awaiting_confirmation"; state: PersistedStageState; artifacts: Artifact[] }
  | { status: "failed"; state: PersistedStageState; error: StageFailedClosedError };
```

`PersistedStageState` must include at least model messages, step counters,
pending interaction id, and stage-local structured state. Intake is the first
stage that must be rewritten to this contract. The support tool loop also needs
this contract before it is usable from the panel.

### Local loopback security

Binding to `127.0.0.1` is not sufficient. Any local process can call loopback,
and browsers can attempt local requests. A2a must include local API auth before
desktop packaging:

- Generate a per-launch high-entropy loopback token at API startup.
- Require the token on every `/v1` route through `Authorization: Bearer <token>`
  or `X-Jantra-Loopback-Token`.
- Electron injects the token into the renderer through preload and never writes
  it to disk.
- The local web dev path receives the token out of band from the server startup
  output or a dev-only file with restricted local permissions.
- Reject unexpected `Host` headers and enforce an Origin allowlist for browser
  clients. Desktop accepts only its app origin and local dev accepts only known
  Vite origins.
- A5 still adds real remote identity and tenancy, but A2a handles local
  drive-by and same-machine abuse risk.

### Streaming granularity

Current `AuditLogger` writes synchronous JSONL and keeps an in-memory `entries`
array for the current process. There is no event bus. The API should expose a
thin run-event projection over audit entries:

- Use audit JSONL as the product-of-record.
- Add a `RunEventBus` for live subscribers while the process is running.
- Backfill `/events` from audit when a client connects with a cursor.
- Do not make the panel depend on raw audit entry internals.

### Definition versioning

Current `Project` has no agent id or version. A1 must add:

- `agentId: string`
- `agentVersion: number`
- `agentDefinitionSnapshot`, containing the stage order, public schemas,
  artifact kinds, gates, and runner keys used at creation time.

Runs should use their snapshot, not the latest registry definition, after they
start. This satisfies PRD C4 and avoids mid-flight definition drift.

### Fastify versus Express

Fastify is still the recommended server choice.

Verified:

- Fastify v5 supports Node.js v20+ per the Fastify v5 migration guide:
  <https://fastify.dev/docs/v5.4.x/Guides/Migration-Guide-V5/>.
- Fastify has first-class schema validation and response serialization using
  JSON Schema, Ajv v8, and fast-json-stringify:
  <https://fastify.dev/docs/v5.7.x/Reference/Validation-and-Serialization/>.
- Fastify's ecosystem lists SSE support, including `@fastify/sse` and
  `fastify-sse`:
  <https://fastify.dev/ecosystem/>.
- `npm.cmd view fastify version engines --json` returned `5.8.5`.
- `npm.cmd view @fastify/sse name version repository engines peerDependencies --json`
  returned package `@fastify/sse`, version `0.4.0`, repository
  `github.com/fastify/sse`, Node `>=20`, and `fastify: ^5.x`.
- `npm.cmd view fastify-sse-v2 name version peerDependencies --json` returned
  package `fastify-sse-v2`, version `4.2.2`, and `fastify: >=4`.

Conclusion: Fastify v5 is the server choice. Do not add an SSE plugin in A2a.
Implement SSE directly with `text/event-stream`, heartbeat comments, explicit
close handling, and event serialization. Add a plugin only if the hand-rolled
route becomes a maintenance problem.

### Electron, Node APIs, and desktop toolchain

Electron is still the right desktop shell, with a version pin requirement.

Verified:

- Electron's main process runs in a Node.js environment with access to Node
  APIs:
  <https://www.electronjs.org/docs/latest/tutorial/process-model>.
- Current Electron releases page showed Electron `42.3.2` with Node.js
  `24.15.0`:
  <https://releases.electronjs.org/>.
- `npm.cmd view electron version engines --json` returned version `42.3.2` and
  install-time engine `node >= 22.12.0`.
- Node's `node:sqlite` module exists in Node 24, is available under the
  `node:` scheme, and is currently Stability `1.2 - Release candidate`:
  <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>.
- `npm.cmd view better-sqlite3 name version engines --json` returned
  `better-sqlite3` version `12.10.0`, supporting Node `20.x` through `26.x`.
- `@google/genai` is the official Google GenAI SDK and Google recommends it for
  Gemini API apps:
  <https://ai.google.dev/gemini-api/docs/libraries>.
- `npm.cmd view @google/genai version engines --json` returned version `2.7.0`
  and Node `>=20.0.0`.
- Electron `safeStorage` is a main-process API for local encryption; on Windows
  it uses DPAPI. The docs recommend the async API:
  <https://www.electronjs.org/docs/latest/api/safe-storage>.
- electron-builder documents `electron-updater` usage:
  <https://www.electron.build/docs/features/auto-update/>.
- electron-builder's Windows docs list NSIS as the default Windows target and
  document signing/update signature verification options:
  <https://www.electron.build/docs/win/>.

Conclusion: Electron can run the existing engine in the main process or a
Node-capable utility process if Electron is pinned to a modern release. Because
`node:sqlite` is still release-candidate stability and desktop will ship to
SMBs, prefer moving the default SQLite implementation to stable
`better-sqlite3` behind `ProjectStore` before A4. Keep the current
`node:sqlite` implementation only as a replaceable local prototype or delete it
once the stable store passes tests. Re-verify and pin Electron, SQLite, Fastify,
and Gemini package versions at build start.

### npm workspaces migration

Verified:

- npm workspaces are configured through the root `package.json` `workspaces`
  field and are auto-symlinked during `npm install`:
  <https://docs.npmjs.com/cli/using-npm/workspaces/>.
- TypeScript project references let multiple TypeScript projects build in
  dependency order and enforce boundaries:
  <https://www.typescriptlang.org/docs/handbook/project-references>.

Current repo touch points:

- `package.json` is currently the root runtime package `@jantra/runtime`.
- `package-lock.json` is single-package.
- `tsconfig.json` has `rootDir: "src"` and `include: ["src/**/*.ts"]`.
- Root scripts run only runtime commands today.

Sequence decision: start workspace migration at the beginning of A2a, before API
dependencies and before `web/` and `desktop/` are introduced. Keep the runtime
in root `src/` for now, as `docs/APP_PLAN.md` requires, and add nested
workspaces later for `web/`, `desktop/`, and `packages/client`.

### ProjectStore pagination and hosted storage

Current `ProjectStore` is not sufficient for hosted listing/filtering:

- `listProjects(clientId): Project[]` returns all projects for a client.
- There is no `agentId`, status, stage, text filter, pagination cursor, or
  `limit`.
- The SQLite implementation stores the full project JSON and selects all rows
  for a client ordered by `updated_at`.

A2a must extend the interface before the API route lands:

- `listProjects(query: ProjectListQuery): ProjectPage`
- `ProjectListQuery` includes `clientId`, `agentId?`, `status?`,
  `currentStage?`, `limit`, and `cursor?`.
- `ProjectSummary` keeps list endpoints light.
- JSON and SQLite implementations can filter in memory or SQL for local use;
  A5 Postgres can implement the same contract with indexes.

### Version pinning

The package and runtime versions verified in this document are point-in-time
facts from June 3, 2026. At the start of each build milestone, re-run the
relevant `npm.cmd view ...` and official-doc checks, then pin versions in
`package.json` or workspace package manifests. This applies to Fastify, any SSE
helper if one is later added, Electron, electron-builder, electron-updater,
`@google/genai`, and the selected SQLite implementation.

## 3. Per-Milestone Plan

## A1 - Agent-Agnostic Core Refactor

Goal: make the planning pipeline the first `AgentDefinition`, not a special
case, while preserving existing runtime behavior.

### Files to create

- `src/agents/definition.ts` - `AgentDefinition`, `StageDefinition`, runner
  kind, gate, model, artifact, and public schema types.
- `src/agents/registry.ts` - registry API for listing, resolving, and
  snapshotting definitions.
- `src/agents/planningPipeline.ts` - the Intake, Research, Planning, disabled
  Build definition.
- `src/agents/supportDefinition.ts` - wraps the existing support agent as a
  one-stage tool-loop definition.
- `src/agents/runners.ts` - registry from runner kind to implementation.

### Files to change

- `src/pipeline/types.ts` - relax stage and artifact ids to string-backed
  definition-owned ids; add `agentId`, `agentVersion`, and
  `agentDefinitionSnapshot` to `Project`; make `CostRollup.perStage` a
  `Record<string, StageCost>`.
- `src/pipeline/orchestrator.ts` - accept an `AgentDefinitionSnapshot` or
  resolved definition, remove `STAGE_RUNNERS`, walk definition stage order, and
  use runner kind instead of stage id.
- `src/config.ts` - move default stage model choices into definitions and add
  model override resolution by agent id plus stage id.
- `src/model/index.ts` and `src/model/mock.ts` - accept string stage ids and
  resolved model choices.
- `src/runtime/telemetry.ts` - initialize per-stage cost from the definition
  snapshot.
- `src/runtime/evals/smoke.ts` and `src/runtime/evals/judge.ts` - remove fixed
  stage keys so `npm.cmd run eval` survives the generic stage-id refactor.
- `src/pipeline/stages/intake.ts`, `research.ts`, `planning.ts` - remove fixed
  `project.stages.intake` style access where possible; use `ctx.stageId` and
  helper accessors.
- `src/pipeline/cli.ts` - resolve the planning pipeline definition from the
  registry before creating or running a project.
- `src/agent.ts` - prepare the support tool loop to run as a stage runner
  without changing its policy/audit behavior.

### Key types and functions

- `AgentDefinition`
- `StageDefinition`
- `StageInteractionMode = "none" | "reentrant"`
- `StageRunnerKind`
- `ReentrantStageRunner` contract, defined here and implemented for interactive
  stages in A2b.
- `AgentDefinitionSnapshot`
- `AgentRegistry.list()`
- `AgentRegistry.get(agentId)`
- `snapshotDefinition(def)`
- `createProject({ clientId, agentId, title, input })`
- `runStage(project, io)`
- `confirmStage(project)`
- `rejectStage(project, reason)`
- `resolveStageModel(definition, stage)`
- `getStageState(project, stageId)`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run pipeline` with the planning pipeline resolved through the
  registry.
- `npm.cmd run support:auto` still works through the existing CLI/runtime path;
  panel-grade support interactions are deferred to A2b.
- `npm.cmd run eval`
- `rg -n "STAGE_RUNNERS|ACTIVE_STAGE_ORDER|STAGE_TITLES|Record<StageId|project\\.stages\\.intake|project\\.stages\\.research|project\\.stages\\.planning" src`

### Acceptance criteria and DoD

- Planning pipeline runs end to end through `AgentRegistry`.
- Support agent is registered as a one-stage definition and remains CLI-runnable;
  API/panel approval wiring is not required until A2b.
- No orchestrator code hardcodes Intake, Research, or Planning stage order.
- Stage ids, artifact kinds, model choices, gates, and display titles are owned
  by definitions.
- Runs pin `agentId`, `agentVersion`, and a definition snapshot at creation.
- Existing runtime guardrails, citation verification, audit, cost ceiling, and
  human gates still work.
- Typecheck and eval pass.

## A2a - Local API Spine, Security, and Events

Goal: add the local `/v1` HTTP boundary, loopback auth, store query contract,
and live event stream without taking on interactive pause/resume yet. Bind only
to `127.0.0.1`.

### Files to create

- `src/server/app.ts` - Fastify app factory with route registration and local
  identity context.
- `src/server/index.ts` - CLI entry point for `npm run server`.
- `src/server/security.ts` - loopback token, Host checks, Origin allowlist,
  request size limits, and localhost-only listen enforcement.
- `src/server/routes/agents.ts` - agent catalog endpoints.
- `src/server/routes/runs.ts` - create, list, detail, advance for
  non-interactive stages, confirm, reject.
- `src/server/routes/artifacts.ts` - artifact and source content endpoints.
- `src/server/routes/audit.ts` - paged audit endpoint.
- `src/server/routes/events.ts` - hand-rolled SSE endpoint.
- `src/server/schemas.ts` - JSON Schema or Zod-derived route contracts.
- `src/server/errors.ts` - typed error to HTTP response mapping.
- `src/server/events.ts` - run-event projection and SSE helpers.

### Files to change

- `package.json` - add `workspaces`, Fastify dependencies, `server` script, and
  workspace-aware root scripts.
- `package-lock.json` - workspace and dependency lock update.
- `tsconfig.json` - keep runtime `rootDir: "src"`; add references or companion
  configs only as workspaces appear.
- `src/pipeline/types.ts` - add API-visible run states and summary types, but
  do not claim interaction resume yet.
- `src/pipeline/store.ts` and SQLite implementation - add paginated lists,
  filters, and project summaries. Prefer moving SQLite to `better-sqlite3`
  before desktop packaging; keep store callers behind `ProjectStore`.
- `src/pipeline/orchestrator.ts` - return a typed "interactive stage not yet
  supported over API" error for stages whose runner requires interaction before
  A2b.
- `src/audit.ts` - optionally publish normalized live events when entries are
  recorded.

### Key endpoints

- `GET /v1/agents`
- `GET /v1/agents/:agentId`
- `POST /v1/runs`
- `GET /v1/runs?agentId=&status=&cursor=&limit=`
- `GET /v1/runs/:runId`
- `POST /v1/runs/:runId/advance`
- `POST /v1/runs/:runId/confirm`
- `POST /v1/runs/:runId/reject`
- `GET /v1/runs/:runId/artifacts/:artifactId`
- `GET /v1/runs/:runId/sources`
- `GET /v1/runs/:runId/audit?cursor=`
- `GET /v1/runs/:runId/events`

### Key types and functions

- `ProjectListQuery`
- `ProjectPage`
- `ProjectSummary`
- `RunEvent`
- `RunEventBus.subscribe(runId, cursor)`
- `createServer({ host: "127.0.0.1", port, loopbackToken })`
- `generateLoopbackToken()`
- `requireLoopbackAuth(request)`
- `validateLocalHostHeader(request)`
- `validateOrigin(request)`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- Fastify `inject()` tests or smoke scripts for all route contracts.
- Auth smoke: missing, wrong, and valid loopback token.
- Host/Origin smoke: reject unexpected Host and Origin values.
- Curl smoke: list agents, create run, read run detail, confirm/reject a
  manually staged gate, read artifacts and audit.
- SSE smoke: connect to `/events`, emit audit-backed events, verify ordering,
  heartbeat, and close cleanup.
- Store tests for JSON and SQLite pagination/filtering.

### Acceptance criteria and DoD

- `/v1` binds only to `127.0.0.1` and every route requires the per-launch
  loopback token.
- Unexpected Host and Origin values are rejected.
- Every route is scoped to a server-side `clientId`.
- API contracts for agents, runs, artifacts, sources, audit, and events are
  stable enough for A3 to start.
- `/events` streams normalized live progress using hand-rolled SSE and can
  backfill from audit.
- `ProjectStore` supports paginated, filtered lists.
- Typecheck and eval pass.

## A2b - Re-Entrant Interactions and Crash-Safe Resume

Goal: re-author interactive stage execution so questions and approvals can
pause, persist, and resume after a process restart. This is the milestone that
delivers HTTP-driven Intake and support approvals.

### Files to create

- `src/runtime/interactions.ts` - `PendingInteraction`, interaction broker,
  CLI adapter, and API adapter.
- `src/pipeline/executionState.ts` - persisted stage messages, step counters,
  pending interaction id, and stage-local state.
- `src/server/routes/interactions.ts` - list and answer pending interactions.
- `src/pipeline/reentrant.ts` - shared `ReentrantStageRunner` helpers and state
  validation.

### Files to change

- `src/pipeline/types.ts` - add `PendingInteraction`, `InteractionStatus`,
  `InteractionResponse`, `PersistedStageState`, and run states such as
  `awaiting_input`.
- `src/pipeline/store.ts` and SQLite implementation - persist interactions and
  stage execution state transactionally with project updates.
- `src/pipeline/orchestrator.ts` - call `start()` or `resume()` on re-entrant
  stages and persist before returning `awaiting_input`.
- `src/pipeline/stages/intake.ts` - rewrite the imperative `for` loop into the
  re-entrant stage contract. Rebuild `messages` from persisted state on every
  invocation.
- `src/pipeline/cli.ts` - use the shared interaction broker with a CLI adapter.
- `src/agent.ts` - route policy approvals through the interaction broker when
  running under the API or definition runner.
- `src/agents/supportDefinition.ts` and `src/agents/runners.ts` - make the
  support tool-loop usable as a re-entrant single-stage definition.

### Key endpoints

- `GET /v1/runs/:runId/interactions`
- `POST /v1/runs/:runId/interactions/:interactionId`

### Key types and functions

- `PendingInteraction`
- `InteractionResponse`
- `InteractionBroker.request()`
- `InteractionBroker.resolve()`
- `PersistedStageState`
- `ReentrantStageRunner.start(ctx)`
- `ReentrantStageRunner.resume(ctx, response)`
- `serializeModelMessages(messages)`
- `loadStageExecutionState(runId, stageId)`
- `saveStageExecutionState(runId, stageId, state)`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- Curl smoke: create run, advance to Intake question, stop the server, restart,
  answer the question, continue to the next question or gate.
- Approval smoke: support definition attempts an ask-gated action, persists
  pending approval, restarts, then resumes after approve or deny.
- CLI smoke: `npm.cmd run pipeline` still uses the same interaction path via
  readline.
- `rg -n "readline|createInterface|question\\(" src/server src/runtime src/pipeline`
  to ensure the server path has no terminal dependency.

### Acceptance criteria and DoD

- Full planning Intake flow is drivable over HTTP, including questions and gate.
- A planning run can continue over HTTP into Research and Planning after Intake
  interactions and stage gates are resolved.
- Support approvals are represented as pending interactions and can be approved
  or denied from HTTP.
- Interactive runs survive process restart because stages rebuild from persisted
  state rather than local async stacks.
- Policy gates, approvals, stage gates, audit, and cost ceiling are enforced
  server-side.
- No terminal blocking exists in the server path.
- Typecheck and eval pass.

## A3 - Panel UI

Goal: build the browser panel that drives any registered agent through the
local API.

### Files to create

- `web/package.json` - React/Vite workspace package.
- `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`.
- `web/src/api/client.ts` - typed `/v1` client.
- `web/src/api/events.ts` - SSE subscription helper.
- `web/src/app/App.tsx` - app shell.
- `web/src/routes/AgentCatalog.tsx` - list and start agents.
- `web/src/routes/RunList.tsx` - filtered paginated runs.
- `web/src/routes/RunDetail.tsx` - timeline, interactions, gate controls,
  artifacts, sources, audit, and cost.
- `web/src/routes/Settings.tsx` - local settings surface, no secrets retained in
  React state beyond the submission event.
- `web/src/components/*` - definition-driven stage timeline, artifact viewer,
  audit timeline, cost panel, interaction panel, and gate controls.
- `web/src/styles.css` - Tailwind and theme tokens.

### Files to change

- `package.json` - add workspace scripts for `web:dev`, `web:build`, and root
  typecheck/build orchestration.
- `package-lock.json`.
- `src/server/app.ts` - CORS/dev origin handling for localhost only.
- `src/server/routes/*` - adjust response shapes only if the UI exposes gaps in
  the API contract.

### Key API-driven UI contracts

- `AgentDefinitionSummary`
- `AgentDefinitionView`
- `RunSummary`
- `RunDetail`
- `StageView`
- `ArtifactView`
- `PendingInteractionView`
- `AuditPage`
- `RunEvent`
- `CostRollupView`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- `npm.cmd run web:build`
- Component tests for generic timeline and interaction rendering.
- Browser verification against the local API using two differently shaped agent
  definitions: planning pipeline and support.
- A3 can begin against A2a for catalog, run list, run detail, artifacts, audit,
  and events. Final interaction controls depend on A2b.
- Visual checks on desktop and mobile widths for text overflow and control
  layout.

### Acceptance criteria and DoD

- Every screen renders from `/v1` responses, not hardcoded pipeline constants.
- After A2b, a user can start, watch, answer, approve, reject, and inspect a run
  entirely in the browser.
- Adding a dummy second agent definition requires no panel code changes.
- The panel shows audit, artifacts, sources, stage status, pending
  interactions, and cost.
- Secrets are never exposed in API responses or persisted in renderer state.
- Typecheck, web build, eval, and browser verification pass.

## A4 - Electron Desktop App

Goal: package the local API plus panel as a thin Windows desktop app.

### Files to create

- `desktop/package.json` - Electron workspace package.
- `desktop/tsconfig.json`.
- `desktop/src/main.ts` - window lifecycle, API startup, userData paths,
  per-launch loopback token creation, single-instance lock, and graceful
  shutdown.
- `desktop/src/preload.ts` - minimal, typed bridge for desktop-only settings.
- `desktop/src/secrets.ts` - async `safeStorage` wrapper for Gemini key storage.
- `desktop/src/paths.ts` - userData database and audit paths.
- `desktop/electron-builder.yml` or package build config.
- `desktop/assets/*` - app icon and installer assets.

### Files to change

- `package.json` - add `desktop:dev`, `desktop:build`, and packaging scripts.
- `package-lock.json`.
- `src/server/app.ts` - support programmatic startup on a random localhost port.
- `src/config.ts` - support injected desktop runtime paths and key source
  without logging secrets.
- `web/src/api/client.ts` - use runtime-discovered localhost API base URL and
  loopback token in desktop.

### Key functions

- `startLocalApi({ host: "127.0.0.1", port: 0, projectDir, auditDir, loopbackToken })`
- `createMainWindow({ apiBaseUrl, loopbackToken })`
- `readGeminiKey()`
- `writeGeminiKey(secret)`
- `configureAutoUpdater()`
- `shutdownApi()`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- `npm.cmd run web:build`
- Electron dev smoke on Windows.
- Packaged app smoke: launch, store key, create run, pause/answer, inspect
  audit.
- SQLite smoke inside the packaged Electron main process using the selected
  store implementation.
- Loopback auth smoke: renderer can call API with preload-provided token; a
  normal browser tab or curl without the token is rejected.
- Verify the renderer never receives the raw Gemini key.
- Installer build smoke with NSIS.

### Acceptance criteria and DoD

- One Windows installer can install and launch Jantra locally.
- Electron shell holds almost no business logic; it starts the API and serves
  the panel.
- API binds to `127.0.0.1` on a random free port and requires the per-launch
  loopback token.
- Data and audit files live under Electron `userData`.
- Gemini key is stored through async `safeStorage`, never in the renderer,
  prompts, logs, or artifacts.
- Auto-update is wired through `electron-updater`.
- A clean Windows machine can complete a planning run locally, except for
  Gemini network calls.

## A5 - Embedding Readiness and Remote API

Goal: expose the same API remotely only after identity, tenancy, and hardening
are in place.

### Files to create

- `src/server/auth/*` - API-key and optional OAuth identity resolution.
- `src/server/tenancy.ts` - strict `clientId` enforcement helpers.
- `src/server/security.ts` - CORS allowlist, rate limits, request size limits,
  and security headers.
- `src/server/webhooks/*` - outbound webhook registration and delivery.
- `packages/client/package.json` - `@jantra/client` SDK workspace.
- `packages/client/src/index.ts` - typed API client.
- `packages/embed-widget/*` or `web/src/embed/*` - embeddable read-mostly run
  widget.
- `src/pipeline/store/postgres.ts` - hosted store implementation if hosting
  needs Postgres in this milestone.

### Files to change

- `package.json`, `package-lock.json`, and workspace scripts.
- `src/server/app.ts` - switch identity mode by deployment config; never allow
  remote anonymous `/v1`.
- `src/server/routes/*` - require identity-derived `clientId`, not caller
  supplied `clientId`.
- `src/pipeline/store.ts` - finalize hosted query/index contract if A2a needs
  any adjustment.
- `web/src/api/client.ts` - support hosted API base URLs and auth headers.

### Key types and functions

- `Identity`
- `TenantContext`
- `ApiKeyRecord`
- `resolveIdentity(request)`
- `requireTenant(request)`
- `assertProjectAccess(identity, project)`
- `WebhookSubscription`
- `WebhookEvent`
- `JantraClient`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- Auth tests for missing, invalid, and valid API keys.
- Cross-tenant access tests for every run, artifact, source, audit, and event
  route.
- CORS and rate-limit tests.
- SDK smoke from an external sample page.
- Webhook delivery and retry tests.

### Acceptance criteria and DoD

- No `/v1` route is reachable off localhost without identity resolving to a
  `clientId`.
- All store queries are scoped by the server-derived `clientId`.
- Cross-tenant access is provably blocked.
- A sample external page can start a run and render results through the SDK or
  widget.
- Webhooks notify run completion and gate/interaction events.
- Remote exposure preserves policy, audit, approvals, fail-closed behavior, and
  cost ceilings.

## A6 - SMB Rollout Hardening

Goal: make the desktop and hosted paths supportable for non-technical SMB users.

### Files to create

- `desktop/src/licensing.ts` - activation and license status checks.
- `desktop/src/diagnostics.ts` - redacted diagnostic bundle creation.
- `desktop/src/backup.ts` - audit/project export and backup helpers.
- `docs/DESKTOP_INSTALL.md` - one-page install and setup guide.
- `docs/SECURITY_NOTES.md` - desktop secret storage, audit, retention, and data
  handling notes.
- `docs/EMBEDDING_GUIDE.md` - SDK/widget setup and API auth guide.

### Files to change

- `desktop/electron-builder.yml` - production signing, channels, artifact names,
  update publishing.
- `desktop/src/main.ts` - crash handling, update channels, diagnostics menu.
- `src/server/app.ts` - production logging and health endpoints.
- `web/src/routes/Settings.tsx` - backup/export/license/update status surfaces.

### Key functions

- `createAuditExport(runId | clientId)`
- `createBackupArchive()`
- `restoreBackupArchive()`
- `collectDiagnostics({ redact: true })`
- `activateLicense(key)`
- `checkForUpdates(channel)`

### Tests and checks

- `npm.cmd run typecheck`
- `npm.cmd run eval`
- Signed installer build on Windows.
- Fresh-machine install test.
- Update-channel smoke.
- Backup/export/restore smoke.
- Diagnostics redaction test.
- Non-technical user walkthrough against the one-page guide.

### Acceptance criteria and DoD

- A non-technical SMB user can install, activate, enter a key, and run an agent.
- Code signing and update channels are ready.
- Audit export and backup are available.
- Crash/error telemetry is redacted and does not include prompts, secrets, or
  raw artifacts unless explicitly exported by the user.
- Installer and embedding docs are complete.

## 4. Sequencing and Dependencies

1. A1 must land before A2a because the API contract is definition-driven. The
   API must not bake in the planning pipeline as a special case.
2. A2a starts with the npm workspace migration, then the secured local API
   spine, store query contract, and hand-rolled SSE.
3. A3 can begin after A2a for read/watch surfaces, but its interaction controls
   are not complete until A2b.
4. A2b delivers the re-entrant interaction contract and crash-safe resume for
   Intake and support approvals.
5. A4 depends on A2a, A2b, and A3. It should pin desktop dependencies after
   re-verification and prefer stable SQLite behind `ProjectStore`.
6. A5 depends on A2a's store query contract and A3's API-driven panel. It is
   the first milestone where `/v1` can be reachable off localhost.
7. A6 depends on a working desktop package and hosted/embedding contracts.

Runtime dependency:

- The current runtime implementation appears to satisfy much of
  `docs/IMPLEMENTATION_PLAN.md` M1-M5 and typechecks now, but the app layer must
  continue to run `npm.cmd run eval` after any refactor touching pipeline,
  audit, store, provider, policy, or stage behavior.
- Do not change Gemini SDK details unless re-verified against official Google
  docs.
- Do not loosen research citation verification, untrusted web content handling,
  cost ceiling, stage gates, or provider-only model access while making stage ids
  generic.

## 5. Risks, Unknowns, and Pre-Milestone Questions

### A1 risks and questions

- Risk: loosening `StageId` can remove useful type safety. Mitigation: validate
  definition ids at registry load and use helpers instead of unchecked string
  indexing.
- Risk: stage code still has planning-specific assumptions. Mitigation: remove
  hardcoded project stage keys and keep planning-specific prompts/schemas inside
  the planning definition.
- Question: should `AgentDefinition.version` be numeric only, or semantic
  version plus revision hash? Recommendation: numeric version plus snapshot hash.

### A2a risks and questions

- Risk: SSE can expose too much raw audit detail. Mitigation: stream normalized
  run events and keep full audit behind a separate paged endpoint.
- Risk: local loopback without auth can be driven by another local process.
  Mitigation: per-launch loopback token, Host checks, and Origin allowlist in
  A2a.
- Question: should A2a keep SQLite on `node:sqlite` temporarily or migrate to
  `better-sqlite3` immediately? Recommendation: migrate to `better-sqlite3`
  before desktop packaging, earlier if the store is already being touched.

### A2b risks and questions

- Risk: pending interactions without a re-entrant runner would lose Intake
  transcript on process restart. Mitigation: rewrite interactive stages to
  `start()` and `resume()` from persisted model messages and stage state.
- Risk: support-agent-as-stage may blur chat loop and artifact semantics.
  Mitigation: treat it as a conversation/run state first, and define its
  artifact as a final run summary only when it completes or hands off.
- Question: should stage confirmation be represented internally as a
  `PendingInteraction` kind or remain a dedicated gate state with confirm/reject
  endpoints? Recommendation: keep dedicated endpoints externally, optionally use
  the same internal interaction broker.

### A3 risks and questions

- Risk: generic UI becomes too abstract to be useful. Mitigation: render from
  definitions, but provide rich generic primitives: timeline, markdown artifacts,
  schema-driven metadata, sources, audit, cost, and interactions.
- Question: should Settings write secrets through an Electron-only bridge or an
  API endpoint in desktop mode? Recommendation: Electron bridge for secret
  storage, API receives only injected env/config at startup or restart.

### A4 risks and questions

- Risk: Electron or SQLite version drift could break desktop storage.
  Mitigation: re-verify and pin versions at build start, prefer stable
  `better-sqlite3` behind `ProjectStore`, and smoke test storage in the
  packaged main process.
- Risk: `safeStorage` protects against other OS users, not every same-user app.
  Mitigation: document semantics and never expose the key to renderer code.
- Risk: a separate browser tab can attempt local API calls. Mitigation:
  preload-provided loopback token plus Host and Origin checks.
- Question: which update host and code-signing certificate will be used for
  Windows? This needs an owner decision before production A4/A6.

### A5 risks and questions

- Risk: remote exposure before tenancy would violate the binding constraints.
  Mitigation: no non-local bind unless auth middleware is active and every route
  has an identity-derived `clientId`.
- Risk: JSON/SQLite store may hide hosted pagination issues. Mitigation: A2a
  adds cursor pagination and A5 adds indexes/Postgres tests before launch.
- Question: API keys, OAuth, or both for first partner embeds? Recommendation:
  API keys first, OAuth when user-level delegation is required.

### A6 risks and questions

- Risk: crash telemetry may leak sensitive client context. Mitigation: default
  to metadata-only telemetry and explicit redacted diagnostic bundles.
- Risk: unsigned or poorly configured updates undermine SMB trust. Mitigation:
  require signed Windows installer and tested update channel before rollout.
- Question: what retention and export defaults should apply to audit logs for
  design partners? This needs a business/security decision before A6.

## 6. Whole-Plan Definition of Done

- `npm.cmd run typecheck` passes.
- `npm.cmd run eval` passes after runtime-affecting changes.
- The engine runs any registered `AgentDefinition`; planning is the first
  definition, not a special case.
- The local `/v1` API fully drives runs, binds only to localhost until A5, and
  requires a per-launch loopback token even in local mode.
- The panel renders generically from agent definitions and run state.
- The desktop app stores secrets in OS-backed storage and keeps the API/engine
  server-side.
- Remote API exposure requires identity resolving to `clientId`.
- Policy gates, approvals, audit, human gates, citation verification, cost
  ceiling, and fail-closed behavior are preserved across every surface.
- Changing an agent's task, operations, output schema, model choice, gates, or
  artifact kinds is a definition change, not an engine/API/panel rewrite.

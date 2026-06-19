# API cheat-sheet

Exact shapes a builder references, copied faithfully from the runtime. Field names and file paths are authoritative — match them exactly; drift between these and your code is a recurring bug class. Verify against the cited file if anything here looks stale.

## Agent definition — `src/agents/definition.ts`

```ts
type StageKind = "model-flow" | "tool-loop" | "disabled";
type StageGate = "human" | "auto" | "disabled";
type StageInteractionMode = "none" | "reentrant";

interface StageDefinition {
  id: string;                 // unique within the agent, stable
  title: string;
  description: string;
  kind: StageKind;
  runnerKind: string;         // "<family>.<stage>", keys into runners.ts maps
  model: StageModelChoice;    // "flash" | "pro" (see src/config.ts)
  artifactKinds: string[];    // every artifact kind this stage emits
  gate: StageGate;
  interactionMode: StageInteractionMode;
  outputSchema?: Record<string, unknown>;
  toolNames?: string[];       // least privilege: exactly the tools used
  enabled?: boolean;          // omit = derived; false to register-but-disable
}

interface AgentDefinition {
  id: string;                 // kebab-case, stable forever
  name: string;
  description: string;        // one sentence, outcome-focused ("Turns X into Y")
  version: number;            // starts at 1; bump on shape changes
  stages: StageDefinition[];  // linear order
  clientScoped: true;         // literal true, always
}
```

- `snapshotDefinition(def)` → `AgentDefinitionSnapshot` with `stageOrder`, `activeStageOrder` (enabled only), and a `snapshotHash` (sha256 of the snapshot). Snapshots are frozen into each project so in-flight runs survive version bumps.
- `validateDefinition(def)` throws if: zero stages, empty/duplicate stage id, or no enabled stage. Fix validation errors — never weaken the validator.
- A disabled future stage: `kind: "disabled"`, `gate: "disabled"`, `enabled: false` (see Build in `planningPipeline.ts`).

### Faithful skeleton

```ts
// src/agents/<agentId>.ts
import type { AgentDefinition } from "./definition.js";

export const myAgentDefinition: AgentDefinition = {
  id: "my-agent",
  name: "My Agent",
  description: "Turns <input> into <verified artifact>.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "intake",
      title: "Intake",
      description: "Clarifies the request into a structured summary.",
      kind: "model-flow",
      runnerKind: "myagent.intake",
      model: "flash",
      artifactKinds: ["request_summary"],
      gate: "human",
      interactionMode: "reentrant",
    },
    // ...more stages
  ],
};
```

Then register in `src/agents/registry.ts` → `defaultAgentRegistry` array (constructor runs `validateDefinition` and rejects duplicate ids).

## Registration & dispatch — `src/agents/registry.ts`, `src/agents/runners.ts`

- `defaultAgentRegistry = new AgentRegistry([ ...definitions ])` — add your definition here.
- `registry.get(id)`, `registry.snapshot(id)`, `registry.list()`.
- Runner maps in `runners.ts`:
  - `RUNNERS: Map<string, StageRunner>` — `["myagent.intake", runMyIntake]`.
  - `REENTRANT_RUNNERS: Map<string, ReentrantStageRunner>` — only for `interactionMode: "reentrant"` stages.
  - `getStageRunner(kind)` / `getReentrantStageRunner(kind)` throw `StageFailedClosedError` for an unregistered kind.

## Stage context & runner contract — `src/pipeline/types.ts`

```ts
type StageRunner = (ctx: StageContext) => Promise<Artifact[]>;

interface StageContext {
  project: Project;                       // full run state
  stageId: StageId;
  stageDefinition: StageDefinitionSnapshot;
  audit: AuditLogger;
  provider: ModelProvider;                // ALL model calls go through this
  io: StageIO;                            // say(msg) / ask(question) -> Promise<string>
  store: ProjectStore;
  rejectionReason?: string;               // set on a reject-and-rerun; steer regeneration
}

interface Artifact {
  stage: StageId;
  kind: ArtifactKind;
  title: string;
  content: string;                        // markdown
  version: number;
  createdAt: string;                      // new Date().toISOString()
  eval?: EvalScore;                       // attach the passing score; autonomy depends on it
}

interface EvalScore {
  rubric: string;
  scores: Record<string, number>;         // dimension -> 1..5
  passed: boolean;
  notes: string;
}
```

## Reentrant state & interactions — `src/pipeline/types.ts`, `src/runtime/interactions.ts`

```ts
interface PersistedStageState {
  stageId: string;
  runnerKind: string;
  step: number;                           // step counter, bounded by config.maxSteps
  messages: ModelMessage[];               // the running transcript
  pendingInteractionId?: string;          // the open question/approval, if any
  data: Record<string, unknown>;          // your stage's bag (phase, followUpRounds, ...)
  updatedAt: string;
}

interface PendingInteraction {
  id: string; runId: string; stageId: string;
  kind: "question" | "approval";
  prompt: string;
  status: "pending" | "answered" | "cancelled";
  toolName?: string; input?: unknown;     // for approval interactions
  // ...
}

interface InteractionResponse { interactionId: string; text?: string; approved?: boolean; }
```

Helpers (used by `runIntakeReentrant`):
- `createQuestionInteraction(project, stageId, prompt)` → a new question interaction.
- `pendingInteraction(project, id)` → the open interaction or undefined.
- `upsertPendingInteraction(project, interaction)` → persist it.
- State helpers: `createStageExecutionState`, `loadStageExecutionState`, `saveStageExecutionState` (`src/pipeline/executionState.ts`).

### Reentrant runner contract — `src/pipeline/reentrant.ts`

```ts
interface ReentrantStageRunner {
  start(ctx): Promise<StageRunStep>;
  resume(ctx, response: InteractionResponse): Promise<StageRunStep>;
}
// StageRunStep (src/pipeline/reentrant.ts) — 3-variant union, NO success variant.
// Completion = awaiting_confirmation with artifacts (the human gate is the happy path):
//   { status: "awaiting_input";        state; interaction }
//   { status: "awaiting_confirmation"; state; artifacts }
//   { status: "failed";                state; error: StageFailedClosedError }
```

`resume` must verify `state.pendingInteractionId === response.interactionId` and reject a mismatch (idempotency: a stale resubmit is a 4xx, not a double-run).

## Provider — `src/model/provider.ts`

```ts
provider.generate({
  purpose: "generator" | "critic" | string,  // audit tag — REQUIRED in spirit
  system: string,
  messages: ModelMessage[],                   // { role: "user" | "model", content }
  tools?: ToolSpec[],                         // { name, description, inputSchema }
  toolChoice?: "auto" | "required" | "none",
  responseJsonSchema?: unknown,               // z.toJSONSchema(zodSchema) for JSON mode
  thinking?: boolean,
  maxOutputTokens?: number,                   // set per call type
  temperature?: number,                       // 0 for critics
  grounding?: boolean,
}): Promise<ModelResult>;

interface ModelResult {
  text: string;                  // assistant text
  message: ModelMessage;         // push onto messages[]
  toolCalls: ToolCall[];         // [{ id?, name, args }]
  thinking?: string;
  citations: GroundingCitation[];
  usage: ModelUsage;             // input/output/cached/thinking/total tokens
  costUsd: number;
  // ...
}
```

Mock provider (`src/model/mock.ts`) drives offline tests via `JANTRA_PROVIDER=mock` + a fixture.

## Typed errors — `src/runtime/errors.ts`

- `StageFailedClosedError(message, context?)` — the canonical fail-closed throw; pass `{ projectId, clientId, eval }` or the claim/ceiling that failed.
- `SchemaValidationError(message, { issues })` — thrown when a structured output fails Zod parse.

Both carry structured context so the human at the handoff can act without re-running.

## Evals & rubric — `src/runtime/evaluator.ts`, `src/runtime/evals/`

```ts
const rubric = { id: "intake", passingScore: 4, criteria: ["specificity", "researchability", ...] };
const evalScore = makeEvalScore(rubric, scores, notes);   // computes passed from passingScore
// then: evalScore.passed = evalScore.passed && critiquePassed;  // AND in deterministic checks
```

- Attach the passing `EvalScore` to the artifact (`Artifact.eval`).
- Offline harness: `npm run smoke` (`src/runtime/evals/smoke.ts`, mock provider, full pipeline), `npm run eval` (regressions/judge). Seed golden + adversarial + abstention cases.

## Cost ceilings & telemetry — `src/runtime/intakeBudget.ts`, `src/runtime/telemetry.ts`

```ts
trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result); // after every generate()
recordIntakeSpend(ctx.store, ctx.project, ctx.stageId, result.costUsd);
enforceIntakeRunCeiling(ctx.audit, ctx.project, ctx.stageId);                   // throws on breach
```

Ceilings come from `JANTRA_*_CEILING_USD` env knobs. Breach is a fail-closed event, not a warning.

## Orchestrator boundary — `src/pipeline/orchestrator.ts`

The orchestrator owns gates, autonomy, run locks, resume, audit rollup. Key behaviors a runner relies on but does not implement:
- `effectiveGate` / conditional autonomy: a `gate: "auto"` stage is auto-confirmed **only** when its eval passed and the run is under its cost ceiling; otherwise it downgrades to a human gate.
- Run locks (`withRunLock`) serialize advance/confirm/reject.
- On a human reject, the next run of the stage receives `ctx.rejectionReason`.

Never design a stage that assumes its gate will be auto.

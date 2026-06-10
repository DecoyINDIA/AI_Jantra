import { randomUUID } from "node:crypto";

import { AuditLogger } from "../audit.js";
import type {
  AgentDefinition,
  AgentDefinitionSnapshot,
  StageDefinitionSnapshot,
} from "../agents/definition.js";
import { snapshotDefinition } from "../agents/definition.js";
import { defaultAgentRegistry, getDefaultAgentDefinition } from "../agents/registry.js";
import { getReentrantStageRunner, getStageRunner } from "../agents/runners.js";
import { config } from "../config.js";
import { createProviderForStage } from "../model/index.js";
import { GateConflictError, StageFailedClosedError } from "../runtime/errors.js";
import { cancelPendingInteractions, resolvePendingInteraction } from "../runtime/interactions.js";
import { gateEventForStatus, publishGateEvent } from "../runtime/gateEvents.js";
import { emptyCostRollup } from "../runtime/telemetry.js";
import type { StageRunStep } from "./reentrant.js";
import { defaultStore, saveProject, type ProjectStore } from "./store.js";
import {
  type Artifact,
  type InteractionResponse,
  type Project,
  type StageContext,
  type StageId,
  type StageIO,
  type StageRunner,
  type StageState,
} from "./types.js";

export interface CreateProjectOptions {
  clientId: string;
  title: string;
  agentId?: string;
  definition?: AgentDefinition;
  /** Catalog model id to pin for this run (Layer 2 in-app switcher). */
  modelId?: string;
  /** Run-level autonomy policy. Defaults to "gated". */
  autonomy?: "gated" | "auto";
}

function emptyStage(id: StageId, status: StageState["status"] = "pending"): StageState {
  return { id, status, artifacts: [], evals: [], updatedAt: new Date().toISOString() };
}

function definitionForProject(project: Project): AgentDefinitionSnapshot {
  return project.agentDefinitionSnapshot ?? snapshotDefinition(getDefaultAgentDefinition());
}

function stageDefinition(
  snapshot: AgentDefinitionSnapshot,
  stageId: StageId,
): StageDefinitionSnapshot {
  const stage = snapshot.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new StageFailedClosedError(`Stage ${stageId} is not in agent ${snapshot.id}.`, {
      agentId: snapshot.id,
      stageId,
    });
  }
  return stage;
}

function firstActiveStage(snapshot: AgentDefinitionSnapshot): StageId {
  const first = snapshot.activeStageOrder[0];
  if (!first) {
    throw new Error(`Agent definition ${snapshot.id} has no enabled stages.`);
  }
  return first;
}

function initialStages(snapshot: AgentDefinitionSnapshot): Record<string, StageState> {
  return Object.fromEntries(
    snapshot.stages.map((stage) => [
      stage.id,
      emptyStage(stage.id, stage.enabled ? "pending" : "skipped"),
    ]),
  );
}

function parseCreateProjectArgs(
  clientIdOrOptions: string | CreateProjectOptions,
  title?: string,
): CreateProjectOptions {
  if (typeof clientIdOrOptions === "string") {
    return { clientId: clientIdOrOptions, title: title ?? "Untitled idea" };
  }
  return clientIdOrOptions;
}

export function createProject(clientId: string, title: string): Project;
export function createProject(options: CreateProjectOptions): Project;
export function createProject(
  clientIdOrOptions: string | CreateProjectOptions,
  title?: string,
): Project {
  const options = parseCreateProjectArgs(clientIdOrOptions, title);
  const definition =
    options.definition ??
    defaultAgentRegistry.get(options.agentId ?? getDefaultAgentDefinition().id);
  const snapshot = snapshotDefinition(definition);
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    title: options.title,
    clientId: options.clientId,
    agentId: snapshot.id,
    agentVersion: snapshot.version,
    agentDefinitionSnapshot: snapshot,
    modelId: options.modelId,
    autonomy: options.autonomy ?? "gated",
    status: "active",
    currentStage: firstActiveStage(snapshot),
    stages: initialStages(snapshot),
    sources: [],
    claims: [],
    interactions: [],
    execution: {},
    cost: emptyCostRollup(snapshot.stageOrder),
    createdAt: now,
    updatedAt: now,
  };
  saveProject(project);
  return project;
}

/**
 * Per-run serialization. The store is last-writer-wins, so two concurrent
 * /advance (or confirm/reject) requests could each load a copy of the project,
 * run a stage, and clobber each other on save — duplicating work and spend.
 * Callers wrap their load→operate→save in withRunLock so a second request for
 * the same run loads only after the first has persisted. Single-process only;
 * a multi-process deployment must move this to the transactional store.
 */
const runLocks = new Map<string, Promise<unknown>>();

export function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prior = runLocks.get(runId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  // Keep the chain alive but swallow rejections so one failure does not poison
  // the lock for subsequent callers.
  runLocks.set(
    runId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Resolve the gate that actually applies to a just-completed stage. A stage is
 * only auto-confirmed when the run opted into autonomy (or the stage is
 * declared auto) AND the conditional-autonomy guardrails hold: every produced
 * artifact's eval passed and the run is under its cost ceiling. Otherwise the
 * gate downgrades to "human" so a person reviews before the run continues.
 */
function effectiveGate(
  project: Project,
  stageDef: StageDefinitionSnapshot,
  stage: StageState,
): "human" | "auto" {
  const wantsAuto = stageDef.gate === "auto" || project.autonomy === "auto";
  if (!wantsAuto) return "human";
  const evalsPassed = stage.artifacts.every((artifact) => !artifact.eval || artifact.eval.passed);
  const underCeiling = project.cost.usd <= config.costCeilingUsd;
  return evalsPassed && underCeiling ? "auto" : "human";
}

function prepareStageRun(project: Project, store: ProjectStore = defaultStore): {
  snapshot: AgentDefinitionSnapshot;
  stageDef: StageDefinitionSnapshot;
  stage: StageState;
  audit: AuditLogger;
} {
  const stageId = project.currentStage;
  const snapshot = definitionForProject(project);
  const stageDef = stageDefinition(snapshot, stageId);
  if (!stageDef.enabled) {
    throw new StageFailedClosedError(`Stage ${stageId} is disabled.`, {
      projectId: project.id,
      clientId: project.clientId,
      agentId: snapshot.id,
    });
  }
  const audit = new AuditLogger(project.id, config.auditDir);
  const stage = getStageState(project, stageId);
  if (stage.status !== "in_progress" && stage.status !== "awaiting_input") {
    const now = new Date().toISOString();
    stage.status = "in_progress";
    stage.updatedAt = now;
    project.updatedAt = now;
    store.saveProject(project);

    audit.record("run_start", {
      clientId: project.clientId,
      agentId: project.agentId,
      agentVersion: project.agentVersion,
      stage: stageId,
      projectId: project.id,
    });
    audit.record("stage_gate", {
      clientId: project.clientId,
      projectId: project.id,
      stage: stageId,
      status: "in_progress",
    });
  }
  return { snapshot, stageDef, stage, audit };
}

function stageContext(
  project: Project,
  snapshot: AgentDefinitionSnapshot,
  stageDef: StageDefinitionSnapshot,
  audit: AuditLogger,
  io: StageIO,
  store: ProjectStore = defaultStore,
  rejectionReason?: string,
): StageContext {
  const stageId = project.currentStage;
  const provider = createProviderForStage(stageId, stageDef.model, snapshot.id, project.modelId);
  return { project, stageId, stageDefinition: stageDef, audit, provider, io, store, rejectionReason };
}

function recordStageFailure(
  project: Project,
  stage: StageState,
  audit: AuditLogger,
  store: ProjectStore,
  err: unknown,
): never {
  stage.status = "rejected";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  // A stage can fail while a question is still outstanding; cancel it so the UI
  // stops surfacing a prompt that can never be answered.
  cancelPendingInteractions(project, stage.id);
  store.saveProject(project);

  const message = err instanceof Error ? err.message : String(err);
  audit.record("error", {
    clientId: project.clientId,
    projectId: project.id,
    stage: stage.id,
    error: message,
  });
  audit.record("handoff", {
    clientId: project.clientId,
    projectId: project.id,
    stage: stage.id,
    reason: "stage_failed_closed",
    summary: message,
  });
  throw err;
}

function completeStageArtifacts(
  project: Project,
  snapshot: AgentDefinitionSnapshot,
  stageDef: StageDefinitionSnapshot,
  stage: StageState,
  audit: AuditLogger,
  store: ProjectStore,
  artifacts: Artifact[],
): void {
  for (const artifact of artifacts) {
    const path = store.writeArtifactFile(project.clientId, project.id, artifact);
    audit.record("agent_message", {
      clientId: project.clientId,
      projectId: project.id,
      stage: stage.id,
      artifactKind: artifact.kind,
      artifactPath: path,
    });
  }

  stage.artifacts.push(...artifacts);
  const gate = effectiveGate(project, stageDef, stage);
  stage.status = gate === "auto" ? "confirmed" : "awaiting_confirmation";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  if (gate === "auto") {
    advanceProject(project, snapshot);
  }
  store.saveProject(project);

  audit.record("stage_gate", {
    clientId: project.clientId,
    projectId: project.id,
    stage: stage.id,
    status: stage.status,
    gate,
    autonomy: project.autonomy ?? "gated",
  });
  audit.record("run_end", {
    clientId: project.clientId,
    stage: stage.id,
    artifactCount: artifacts.length,
    cost: project.cost,
  });

  // Notify operators when the run stops at a human gate so gate latency does
  // not depend on someone having the UI open.
  if (gate !== "auto") {
    publishGateEvent(gateEventForStatus(project, stage.id, "awaiting_confirmation"));
  }
}

const inertIo: StageIO = {
  say: () => undefined,
  ask: async () => {
    throw new StageFailedClosedError("Stage is awaiting persisted input.");
  },
};

async function startReentrantStage(
  project: Project,
  io: StageIO,
  store: ProjectStore,
  rejectionReason?: string,
): Promise<StageRunStep> {
  const { snapshot, stageDef, stage, audit } = prepareStageRun(project, store);
  try {
    const runner = getReentrantStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io, store, rejectionReason);
    const step = await runner.start(ctx);
    persistStageStep(project, snapshot, stageDef, stage, audit, store, step);
    return step;
  } catch (err) {
    recordStageFailure(project, stage, audit, store, err);
  }
}

export async function resumeStageInteraction(
  project: Project,
  response: InteractionResponse,
  io: StageIO = inertIo,
  store: ProjectStore = defaultStore,
): Promise<StageRunStep> {
  resolvePendingInteraction(project, response);
  const { snapshot, stageDef, stage, audit } = prepareStageRun(project, store);
  try {
    const runner = getReentrantStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io, store);
    const step = await runner.resume(ctx, response);
    persistStageStep(project, snapshot, stageDef, stage, audit, store, step);
    return step;
  } catch (err) {
    recordStageFailure(project, stage, audit, store, err);
  }
}

function persistStageStep(
  project: Project,
  snapshot: AgentDefinitionSnapshot,
  stageDef: StageDefinitionSnapshot,
  stage: StageState,
  audit: AuditLogger,
  store: ProjectStore,
  step: StageRunStep,
): void {
  if (step.status === "awaiting_input") {
    stage.status = "awaiting_input";
    stage.updatedAt = new Date().toISOString();
    project.updatedAt = stage.updatedAt;
    store.saveProject(project);
    audit.record("stage_gate", {
      clientId: project.clientId,
      projectId: project.id,
      stage: stage.id,
      status: "awaiting_input",
      interactionId: step.interaction.id,
    });
    publishGateEvent(
      gateEventForStatus(project, stage.id, "awaiting_input", step.interaction.id),
    );
    return;
  }
  if (step.status === "awaiting_confirmation") {
    completeStageArtifacts(project, snapshot, stageDef, stage, audit, store, step.artifacts);
    return;
  }
  recordStageFailure(project, stage, audit, store, step.error);
}

export async function advanceStage(
  project: Project,
  io: StageIO = inertIo,
  store: ProjectStore = defaultStore,
): Promise<StageRunStep> {
  const stageId = project.currentStage;
  const stage = getStageState(project, stageId);

  // Gate enforcement (server-side, not just the UI): never re-run a stage that
  // already produced its artifacts and is waiting at the gate, was confirmed,
  // or was skipped. Re-running would duplicate artifacts, claims, and spend.
  if (stage.status === "awaiting_confirmation") {
    throw new GateConflictError(
      `Stage ${stageId} is awaiting confirmation; confirm or reject it before advancing.`,
      { projectId: project.id, stage: stageId, status: stage.status },
    );
  }
  if (stage.status === "confirmed" || stage.status === "skipped") {
    throw new GateConflictError(`Stage ${stageId} is already ${stage.status}.`, {
      projectId: project.id,
      stage: stageId,
      status: stage.status,
    });
  }

  // Rejected rerun: carry the reviewer's reason into regeneration and wipe the
  // prior (rejected) output plus any cached per-stage execution state, so the
  // stage truly regenerates with the feedback rather than replaying its cache.
  let rejectionReason: string | undefined;
  if (stage.status === "rejected") {
    rejectionReason = stage.rejectionReason;
    stage.artifacts = [];
    stage.evals = [];
    stage.rejectionReason = undefined;
    delete project.execution[stageId];
    cancelPendingInteractions(project, stageId);
  }

  const { snapshot, stageDef, audit } = prepareStageRun(project, store);
  if (stageDef.interactionMode === "reentrant") {
    return startReentrantStage(project, io, store, rejectionReason);
  }
  try {
    const runner: StageRunner = getStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io, store, rejectionReason);
    const artifacts = await runner(ctx);
    completeStageArtifacts(project, snapshot, stageDef, stage, audit, store, artifacts);
    return {
      status: "awaiting_confirmation",
      state: {
        stageId: stage.id,
        runnerKind: stageDef.runnerKind,
        step: 0,
        messages: [],
        data: {},
        updatedAt: new Date().toISOString(),
      },
      artifacts,
    };
  } catch (err) {
    recordStageFailure(project, stage, audit, store, err);
  }
}

export async function runStage(
  project: Project,
  io: StageIO,
  store: ProjectStore = defaultStore,
): Promise<Artifact[]> {
  let step = await advanceStage(project, io, store);
  while (step.status === "awaiting_input") {
    io.say(step.interaction.prompt);
    const text = await io.ask(step.interaction.prompt);
    step = await resumeStageInteraction(
      project,
      { interactionId: step.interaction.id, text },
      io,
      store,
    );
  }
  if (step.status === "failed") throw step.error;
  return step.artifacts;
}

/**
 * Run driver: advance the current stage and keep going while stages
 * auto-confirm under the run's autonomy policy, stopping at the first human
 * gate, a question awaiting input, a failure, or completion. This is what makes
 * autonomy an actual engine rather than a client polling loop — for a "gated"
 * run the first human-gated stage stops it after one step, matching the prior
 * single-stage behavior.
 */
export async function advanceUntilGate(
  project: Project,
  io: StageIO = inertIo,
  store: ProjectStore = defaultStore,
): Promise<StageRunStep> {
  let step = await advanceStage(project, io, store);
  // After advanceStage, an auto-confirmed stage has already advanced
  // project.currentStage to the next pending stage; keep running until a stage
  // stops at a human gate (awaiting_confirmation), needs input, fails, or the
  // run completes.
  while (
    project.status === "active" &&
    step.status === "awaiting_confirmation" &&
    project.stages[project.currentStage]?.status === "pending"
  ) {
    step = await advanceStage(project, io, store);
  }
  return step;
}

/**
 * After a human confirms a downgraded gate, or answers an interaction that
 * lets an autonomous stage auto-confirm, resume driving the remaining stages
 * for an "auto" run. No-op for gated runs or when the run is not sitting on a
 * freshly-advanced pending stage.
 */
export async function continueAutonomously(
  project: Project,
  io: StageIO = inertIo,
  store: ProjectStore = defaultStore,
): Promise<StageRunStep | null> {
  if (project.autonomy !== "auto" || project.status !== "active") return null;
  if (project.stages[project.currentStage]?.status !== "pending") return null;
  return advanceUntilGate(project, io, store);
}

export function confirmStage(project: Project, store: ProjectStore = defaultStore): StageId | null {
  const stageId = project.currentStage;
  const snapshot = definitionForProject(project);
  const stage = getStageState(project, stageId);

  // Gate enforcement: a stage can only be confirmed once it has actually
  // reached the gate. Without this, a client could POST /confirm on a pending
  // or in-progress stage and advance the whole pipeline without any stage ever
  // running. This is the product's central invariant — it lives here, not in
  // the disabled-button state of the UI.
  if (stage.status !== "awaiting_confirmation") {
    throw new GateConflictError(
      `Stage ${stageId} cannot be confirmed from status "${stage.status}"; it must be awaiting confirmation.`,
      { projectId: project.id, stage: stageId, status: stage.status },
    );
  }

  stage.status = "confirmed";
  stage.updatedAt = new Date().toISOString();

  const next = advanceProject(project, snapshot);
  project.updatedAt = new Date().toISOString();
  store.saveProject(project);
  return next;
}

export function rejectStage(
  project: Project,
  reason: string,
  store: ProjectStore = defaultStore,
): void {
  const stage = getStageState(project, project.currentStage);

  // Gate enforcement: only a stage sitting at the gate can be rejected.
  if (stage.status !== "awaiting_confirmation") {
    throw new GateConflictError(
      `Stage ${project.currentStage} cannot be rejected from status "${stage.status}"; it must be awaiting confirmation.`,
      { projectId: project.id, stage: project.currentStage, status: stage.status },
    );
  }

  stage.status = "rejected";
  stage.rejectionReason = reason;
  stage.updatedAt = new Date().toISOString();
  // Drop any outstanding question so a rerun starts clean.
  cancelPendingInteractions(project, stage.id);
  project.updatedAt = stage.updatedAt;
  store.saveProject(project);
}

function advanceProject(
  project: Project,
  snapshot: AgentDefinitionSnapshot = definitionForProject(project),
): StageId | null {
  const idx = snapshot.activeStageOrder.indexOf(project.currentStage);
  const next = snapshot.activeStageOrder[idx + 1] ?? null;
  if (next) {
    project.currentStage = next;
  } else {
    project.status = "completed";
  }
  return next;
}

export function getStageState(project: Project, stageId: StageId): StageState {
  const stage = project.stages[stageId];
  if (!stage) {
    throw new StageFailedClosedError(`Project ${project.id} has no stage ${stageId}.`, {
      projectId: project.id,
      clientId: project.clientId,
      stage: stageId,
    });
  }
  return stage;
}

export function latestArtifact(project: Project, kind: string): Artifact | null {
  return (
    Object.values(project.stages)
      .flatMap((stage) => stage.artifacts)
      .filter((candidate) => candidate.kind === kind)
      .at(-1) ?? null
  );
}

export function stageTitle(
  id: StageId,
  snapshot: AgentDefinitionSnapshot = snapshotDefinition(getDefaultAgentDefinition()),
): string {
  return snapshot.stages.find((stage) => stage.id === id)?.title ?? id;
}

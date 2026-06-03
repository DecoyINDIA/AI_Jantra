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
import { StageFailedClosedError } from "../runtime/errors.js";
import { resolvePendingInteraction } from "../runtime/interactions.js";
import { emptyCostRollup } from "../runtime/telemetry.js";
import type { StageRunStep } from "./reentrant.js";
import { saveProject, writeArtifactFile } from "./store.js";
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

function prepareStageRun(project: Project): {
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
    saveProject(project);

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
): StageContext {
  const stageId = project.currentStage;
  const provider = createProviderForStage(stageId, stageDef.model, snapshot.id);
  return { project, stageId, stageDefinition: stageDef, audit, provider, io };
}

function recordStageFailure(
  project: Project,
  stage: StageState,
  audit: AuditLogger,
  err: unknown,
): never {
  stage.status = "rejected";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  saveProject(project);

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
  artifacts: Artifact[],
): void {
  for (const artifact of artifacts) {
    const path = writeArtifactFile(project.clientId, project.id, artifact);
    audit.record("agent_message", {
      clientId: project.clientId,
      projectId: project.id,
      stage: stage.id,
      artifactKind: artifact.kind,
      artifactPath: path,
    });
  }

  stage.artifacts.push(...artifacts);
  stage.status = stageDef.gate === "auto" ? "confirmed" : "awaiting_confirmation";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  if (stageDef.gate === "auto") {
    advanceProject(project, snapshot);
  }
  saveProject(project);

  audit.record("stage_gate", {
    clientId: project.clientId,
    projectId: project.id,
    stage: stage.id,
    status: stage.status,
  });
  audit.record("run_end", {
    clientId: project.clientId,
    stage: stage.id,
    artifactCount: artifacts.length,
    cost: project.cost,
  });
}

const inertIo: StageIO = {
  say: () => undefined,
  ask: async () => {
    throw new StageFailedClosedError("Stage is awaiting persisted input.");
  },
};

async function startReentrantStage(project: Project, io: StageIO): Promise<StageRunStep> {
  const { snapshot, stageDef, stage, audit } = prepareStageRun(project);
  try {
    const runner = getReentrantStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io);
    const step = await runner.start(ctx);
    persistStageStep(project, snapshot, stageDef, stage, audit, step);
    return step;
  } catch (err) {
    recordStageFailure(project, stage, audit, err);
  }
}

export async function resumeStageInteraction(
  project: Project,
  response: InteractionResponse,
  io: StageIO = inertIo,
): Promise<StageRunStep> {
  resolvePendingInteraction(project, response);
  const { snapshot, stageDef, stage, audit } = prepareStageRun(project);
  try {
    const runner = getReentrantStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io);
    const step = await runner.resume(ctx, response);
    persistStageStep(project, snapshot, stageDef, stage, audit, step);
    return step;
  } catch (err) {
    recordStageFailure(project, stage, audit, err);
  }
}

function persistStageStep(
  project: Project,
  snapshot: AgentDefinitionSnapshot,
  stageDef: StageDefinitionSnapshot,
  stage: StageState,
  audit: AuditLogger,
  step: StageRunStep,
): void {
  if (step.status === "awaiting_input") {
    stage.status = "awaiting_input";
    stage.updatedAt = new Date().toISOString();
    project.updatedAt = stage.updatedAt;
    saveProject(project);
    audit.record("stage_gate", {
      clientId: project.clientId,
      projectId: project.id,
      stage: stage.id,
      status: "awaiting_input",
      interactionId: step.interaction.id,
    });
    return;
  }
  if (step.status === "awaiting_confirmation") {
    completeStageArtifacts(project, snapshot, stageDef, stage, audit, step.artifacts);
    return;
  }
  recordStageFailure(project, stage, audit, step.error);
}

export async function advanceStage(project: Project, io: StageIO = inertIo): Promise<StageRunStep> {
  const { snapshot, stageDef, stage, audit } = prepareStageRun(project);
  if (stageDef.interactionMode === "reentrant") {
    return startReentrantStage(project, io);
  }
  try {
    const runner: StageRunner = getStageRunner(stageDef.runnerKind);
    const ctx = stageContext(project, snapshot, stageDef, audit, io);
    const artifacts = await runner(ctx);
    completeStageArtifacts(project, snapshot, stageDef, stage, audit, artifacts);
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
    recordStageFailure(project, stage, audit, err);
  }
}

export async function runStage(project: Project, io: StageIO): Promise<Artifact[]> {
  let step = await advanceStage(project, io);
  while (step.status === "awaiting_input") {
    io.say(step.interaction.prompt);
    const text = await io.ask(step.interaction.prompt);
    step = await resumeStageInteraction(project, { interactionId: step.interaction.id, text }, io);
  }
  if (step.status === "failed") throw step.error;
  return step.artifacts;
}

export function confirmStage(project: Project): StageId | null {
  const stageId = project.currentStage;
  const snapshot = definitionForProject(project);
  const stage = getStageState(project, stageId);
  stage.status = "confirmed";
  stage.updatedAt = new Date().toISOString();

  const next = advanceProject(project, snapshot);
  project.updatedAt = new Date().toISOString();
  saveProject(project);
  return next;
}

export function rejectStage(project: Project, reason: string): void {
  const stage = getStageState(project, project.currentStage);
  stage.status = "rejected";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  saveProject(project);
  void reason;
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

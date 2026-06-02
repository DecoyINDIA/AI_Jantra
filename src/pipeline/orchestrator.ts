import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { AuditLogger } from "../audit.js";
import { saveProject, writeArtifactFile } from "./store.js";
import { runIntake } from "./stages/intake.js";
import {
  STAGE_ORDER,
  STAGE_TITLES,
  type Artifact,
  type Project,
  type StageContext,
  type StageId,
  type StageIO,
  type StageRunner,
  type StageState,
} from "./types.js";

/**
 * Stage registry. All four stages are wired here so the pipeline is structurally
 * complete; implementations land incrementally. An unimplemented stage fails
 * loudly rather than pretending to work.
 */
const STAGE_RUNNERS: Record<StageId, StageRunner> = {
  intake: runIntake,
  research: notImplemented("research"),
  planning: notImplemented("planning"),
  build: notImplemented("build"),
};

function notImplemented(stage: StageId): StageRunner {
  return async () => {
    throw new Error(
      `Stage "${stage}" is not built yet. See docs/PIPELINE.md for the increment roadmap.`,
    );
  };
}

function emptyStage(id: StageId): StageState {
  return { id, status: "pending", artifacts: [], updatedAt: new Date().toISOString() };
}

export function createProject(clientId: string, title: string): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    title,
    clientId,
    status: "active",
    currentStage: "intake",
    stages: {
      intake: emptyStage("intake"),
      research: emptyStage("research"),
      planning: emptyStage("planning"),
      build: emptyStage("build"),
    },
    createdAt: now,
    updatedAt: now,
  };
  saveProject(project);
  return project;
}

/**
 * Run the project's current stage. Produces artifacts and leaves the stage
 * "awaiting_confirmation" — the gate. Call confirmStage() to advance.
 */
export async function runStage(
  project: Project,
  io: StageIO,
  client: Anthropic = new Anthropic(),
): Promise<Artifact[]> {
  const stageId = project.currentStage;
  const audit = new AuditLogger(project.id, config.auditDir);
  const stage = project.stages[stageId];

  stage.status = "in_progress";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  saveProject(project);

  audit.record("run_start", {
    pipeline: "onboarding",
    stage: stageId,
    project: project.id,
    clientId: project.clientId,
  });

  const ctx: StageContext = { project, audit, client, io };
  const artifacts = await STAGE_RUNNERS[stageId](ctx);

  for (const artifact of artifacts) {
    const path = writeArtifactFile(project.clientId, project.id, artifact);
    audit.record("agent_message", {
      stage: stageId,
      artifactKind: artifact.kind,
      artifactPath: path,
    });
  }

  stage.artifacts.push(...artifacts);
  stage.status = "awaiting_confirmation";
  stage.updatedAt = new Date().toISOString();
  project.updatedAt = stage.updatedAt;
  saveProject(project);

  audit.record("run_end", { stage: stageId, artifactCount: artifacts.length });
  return artifacts;
}

/**
 * The human gate. Confirm the current stage's output and advance to the next.
 * Returns the new current stage, or null if the pipeline is complete.
 */
export function confirmStage(project: Project): StageId | null {
  const stageId = project.currentStage;
  const stage = project.stages[stageId];
  stage.status = "confirmed";
  stage.updatedAt = new Date().toISOString();

  const idx = STAGE_ORDER.indexOf(stageId);
  const next = STAGE_ORDER[idx + 1] ?? null;
  if (next) {
    project.currentStage = next;
  } else {
    project.status = "completed";
  }
  project.updatedAt = new Date().toISOString();
  saveProject(project);
  return next;
}

export function stageTitle(id: StageId): string {
  return STAGE_TITLES[id];
}

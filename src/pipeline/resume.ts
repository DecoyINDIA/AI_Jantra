import type { AuditLogger } from "../audit.js";
import { loadProject, saveProject } from "./store.js";
import type { Project, StageId } from "./types.js";

export function resumeProjectRun(
  clientId: string,
  projectId: string,
  audit?: AuditLogger,
): Project {
  const project = loadProject(clientId, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} for client ${clientId} was not found.`);
  }

  const stage = project.stages[project.currentStage];
  if (!stage) {
    throw new Error(`Project ${projectId} has no current stage ${project.currentStage}.`);
  }
  if (stage.status === "in_progress" || stage.status === "rejected") {
    stage.status = "pending";
    stage.updatedAt = new Date().toISOString();
    project.updatedAt = stage.updatedAt;
    saveProject(project);
  }

  audit?.record("resume", {
    clientId,
    projectId,
    currentStage: project.currentStage,
    status: stage.status,
  });
  return project;
}

export function nextResumableStage(project: Project): StageId {
  return project.currentStage;
}

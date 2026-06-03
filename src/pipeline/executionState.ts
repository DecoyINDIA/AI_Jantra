import type { PersistedStageState, Project } from "./types.js";

export function loadStageExecutionState(
  project: Project,
  stageId: string,
): PersistedStageState | null {
  return project.execution[stageId] ?? null;
}

export function saveStageExecutionState(
  project: Project,
  stageId: string,
  state: PersistedStageState,
): void {
  state.updatedAt = new Date().toISOString();
  project.execution[stageId] = state;
}

export function createStageExecutionState(
  stageId: string,
  runnerKind: string,
  data: Record<string, unknown> = {},
): PersistedStageState {
  return {
    stageId,
    runnerKind,
    step: 0,
    messages: [],
    data,
    updatedAt: new Date().toISOString(),
  };
}

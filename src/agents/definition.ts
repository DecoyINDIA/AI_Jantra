import { createHash } from "node:crypto";

import type { StageModelChoice } from "../config.js";

export type StageKind = "model-flow" | "tool-loop" | "disabled";
export type StageGate = "human" | "auto" | "disabled";
export type StageInteractionMode = "none" | "reentrant";
export type StageRunnerKind = string;

export interface StageDefinition {
  id: string;
  title: string;
  description: string;
  kind: StageKind;
  runnerKind: StageRunnerKind;
  model: StageModelChoice;
  artifactKinds: string[];
  gate: StageGate;
  interactionMode: StageInteractionMode;
  outputSchema?: Record<string, unknown>;
  toolNames?: string[];
  enabled?: boolean;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  stages: StageDefinition[];
  clientScoped: true;
}

export interface StageDefinitionSnapshot extends StageDefinition {
  enabled: boolean;
}

export interface AgentDefinitionSnapshot {
  id: string;
  name: string;
  description: string;
  version: number;
  clientScoped: true;
  stages: StageDefinitionSnapshot[];
  stageOrder: string[];
  activeStageOrder: string[];
  snapshotHash: string;
}

function snapshotStage(stage: StageDefinition): StageDefinitionSnapshot {
  return {
    ...stage,
    enabled: stage.enabled ?? (stage.kind !== "disabled" && stage.gate !== "disabled"),
    artifactKinds: [...stage.artifactKinds],
    toolNames: stage.toolNames ? [...stage.toolNames] : undefined,
    outputSchema: stage.outputSchema ? { ...stage.outputSchema } : undefined,
  };
}

export function snapshotDefinition(definition: AgentDefinition): AgentDefinitionSnapshot {
  const stages = definition.stages.map(snapshotStage);
  const snapshotBase = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    clientScoped: definition.clientScoped,
    stages,
    stageOrder: stages.map((stage) => stage.id),
    activeStageOrder: stages.filter((stage) => stage.enabled).map((stage) => stage.id),
  };
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify(snapshotBase))
    .digest("hex");
  return { ...snapshotBase, snapshotHash };
}

export function validateDefinition(definition: AgentDefinition): void {
  if (!definition.stages.length) {
    throw new Error(`Agent definition ${definition.id} must declare at least one stage.`);
  }
  const ids = new Set<string>();
  for (const stage of definition.stages) {
    if (!stage.id.trim()) {
      throw new Error(`Agent definition ${definition.id} has a stage with an empty id.`);
    }
    if (ids.has(stage.id)) {
      throw new Error(`Agent definition ${definition.id} has duplicate stage id ${stage.id}.`);
    }
    ids.add(stage.id);
  }
  if (!definition.stages.some((stage) => stage.enabled ?? (stage.kind !== "disabled"))) {
    throw new Error(`Agent definition ${definition.id} must have at least one enabled stage.`);
  }
}

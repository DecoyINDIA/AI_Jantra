import {
  snapshotDefinition,
  validateDefinition,
  type AgentDefinition,
  type AgentDefinitionSnapshot,
} from "./definition.js";
import { planningPipelineDefinition } from "./planningPipeline.js";
import { supportAgentDefinition } from "./supportDefinition.js";

export interface AgentDefinitionSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  stageCount: number;
}

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(definitions: AgentDefinition[]) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: AgentDefinition): void {
    validateDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`Agent definition ${definition.id} is already registered.`);
    }
    this.definitions.set(definition.id, definition);
  }

  list(): AgentDefinitionSummary[] {
    return [...this.definitions.values()].map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      stageCount: definition.stages.length,
    }));
  }

  get(agentId: string): AgentDefinition {
    const definition = this.definitions.get(agentId);
    if (!definition) {
      throw new Error(`Agent definition ${agentId} was not found.`);
    }
    return definition;
  }

  snapshot(agentId: string): AgentDefinitionSnapshot {
    return snapshotDefinition(this.get(agentId));
  }
}

export const defaultAgentRegistry = new AgentRegistry([
  planningPipelineDefinition,
  supportAgentDefinition,
]);

export function getDefaultAgentDefinition(): AgentDefinition {
  return planningPipelineDefinition;
}

import { config, getModelId, getModelIdForStage, resolveStageModel, type StageModelChoice } from "../config.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import type { ModelProvider } from "./provider.js";

export function createProviderForStage(
  stage: string,
  modelChoice?: StageModelChoice,
  agentId = "planning-pipeline",
): ModelProvider {
  const resolvedChoice = modelChoice ?? resolveStageModel(agentId, stage, "flash");
  const modelId = modelChoice ? getModelId(resolvedChoice) : getModelIdForStage(stage, resolvedChoice, agentId);
  if (config.provider === "mock") {
    return new MockProvider(stage, modelId, config.mockFixturePath);
  }
  return new GeminiProvider(modelId);
}

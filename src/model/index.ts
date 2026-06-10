import { config, getModelId, resolveStageModel, type GeminiModelId, type StageModelChoice } from "../config.js";
import { resolveCatalog, type CatalogModel } from "./catalog.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type { ModelProvider } from "./provider.js";

export function createProviderForStage(
  stage: string,
  modelChoice?: StageModelChoice,
  agentId = "planning-pipeline",
  runModelId?: string,
): ModelProvider {
  const choice = modelChoice ?? resolveStageModel(agentId, stage, "flash");
  const geminiModelId = getModelId(choice);

  if (config.provider === "mock") {
    return new MockProvider(stage, geminiModelId, config.mockFixturePath);
  }

  // Layer 2: a run can pin a catalog model picked in the UI. When set, every
  // stage uses that model — except grounded research, which is delegated to
  // Gemini inside OpenAICompatibleProvider (or handled natively by Gemini).
  const selected = runModelId ? resolveCatalog(runModelId) : undefined;
  if (selected) {
    return providerForCatalogModel(selected, geminiModelId);
  }

  if (config.provider === "openai-compatible") {
    return new OpenAICompatibleProvider({
      id: choice === "pro" ? config.llmModelPro : config.llmModelFlash,
      baseUrl: config.baseUrl,
      apiKey: config.llmApiKey,
      // Grounded research calls fall back to Gemini (hybrid).
      groundingModelId: geminiModelId,
      pricing: {
        inputPerMillion: config.llmPriceInputPerMillion,
        outputPerMillion: config.llmPriceOutputPerMillion,
      },
    });
  }

  return new GeminiProvider(geminiModelId);
}

function providerForCatalogModel(
  model: CatalogModel,
  stageGroundingModelId: GeminiModelId,
): ModelProvider {
  if (model.provider === "gemini") {
    return new GeminiProvider(model.model as GeminiModelId);
  }
  return new OpenAICompatibleProvider({
    id: model.model,
    baseUrl: config.baseUrl,
    apiKey: config.llmApiKey,
    // Hybrid: grounded calls run on Gemini, using the stage tier's Gemini model.
    groundingModelId: stageGroundingModelId,
    pricing: {
      inputPerMillion: config.llmPriceInputPerMillion,
      outputPerMillion: config.llmPriceOutputPerMillion,
    },
  });
}

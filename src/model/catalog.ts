import { config, type GeminiModelId, type StageModelChoice } from "../config.js";

/**
 * Server-side model catalog — the single source of truth for which models a run
 * may use (Layer 2 of the multi-LLM plan). The UI renders buttons from this list
 * via `GET /v1/models`; the server controls which models (and therefore which
 * keys/costs) are allowed. A run stores a catalog `id`; `createProviderForStage`
 * resolves it back to a concrete provider.
 *
 * Adding a model = one entry here. No pipeline/agent code changes.
 */

export type CatalogProvider = "gemini" | "openai-compatible";

export interface CatalogModel {
  /** Stable id stored on the run and sent by the UI, e.g. "claude-sonnet-4". */
  id: string;
  /** Human label rendered on the button. */
  label: string;
  /** Which provider implementation serves this model. */
  provider: CatalogProvider;
  /** Provider-specific model string sent to the API. */
  model: string;
  /** Informational tier; also picks the Gemini tier used for grounded calls. */
  tier: StageModelChoice;
  /** Whether the model supports tool-calling (matters for agent/planning stages). */
  supportsTools: boolean;
}

/**
 * Curated list of selectable models. OpenAI-compatible entries assume the
 * default OpenRouter route (`JANTRA_BASE_URL`); switch hosts by changing that
 * env var. Gemini entries run directly against the Gemini API.
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    tier: "flash",
    supportsTools: true,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    tier: "pro",
    supportsTools: true,
  },
  // Current-generation Anthropic flagships. NOTE: verify the exact OpenRouter
  // model slugs against https://openrouter.ai/models before relying on these in
  // production — OpenRouter's slug for a given release can differ from the
  // Anthropic API id (claude-opus-4-8 / claude-sonnet-4-6). The older 4.0
  // entries are kept below so runs that already pinned them still resolve.
  {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "openai-compatible",
    model: "anthropic/claude-opus-4.8",
    tier: "pro",
    supportsTools: true,
  },
  {
    id: "claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    provider: "openai-compatible",
    model: "anthropic/claude-sonnet-4.6",
    tier: "flash",
    supportsTools: true,
  },
  {
    id: "claude-sonnet-4",
    label: "Claude Sonnet 4",
    provider: "openai-compatible",
    model: "anthropic/claude-sonnet-4",
    tier: "flash",
    supportsTools: true,
  },
  {
    id: "claude-opus-4",
    label: "Claude Opus 4",
    provider: "openai-compatible",
    model: "anthropic/claude-opus-4",
    tier: "pro",
    supportsTools: true,
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai-compatible",
    model: "openai/gpt-4.1",
    tier: "pro",
    supportsTools: true,
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek V3",
    provider: "openai-compatible",
    model: "deepseek/deepseek-chat",
    tier: "flash",
    supportsTools: true,
  },
  // DeepSeek V4 Flash — efficiency-optimized MoE (284B total / 13B active), 1M
  // context. Released 2026-04-24. Slug verified against openrouter.ai.
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "openai-compatible",
    model: "deepseek/deepseek-v4-flash",
    tier: "flash",
    supportsTools: true,
  },
  {
    id: "llama-3.3-70b",
    label: "Llama 3.3 70B",
    provider: "openai-compatible",
    model: "meta-llama/llama-3.3-70b-instruct",
    tier: "flash",
    supportsTools: true,
  },
  {
    id: "perplexity-sonar",
    label: "Perplexity Sonar (research)",
    provider: "openai-compatible",
    model: "perplexity/sonar",
    tier: "flash",
    // Search-tuned; weak/no tool-calling — fine for research, weak as the agent.
    supportsTools: false,
  },
];

export function resolveCatalog(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

/** The Gemini tier used for the hybrid grounding fallback of a catalog model. */
export function groundingModelFor(model: CatalogModel): GeminiModelId {
  return model.tier === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
}

/**
 * Whether the running server has the keys/config needed to serve a model. The
 * UI uses this to disable buttons it cannot actually run.
 */
export function isCatalogModelAvailable(model: CatalogModel): boolean {
  if (config.provider === "mock") return true;
  if (model.provider === "gemini") return Boolean(config.geminiApiKey);
  // openai-compatible
  return Boolean(config.llmApiKey && config.baseUrl);
}

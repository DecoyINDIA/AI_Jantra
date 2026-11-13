import fs from "node:fs";
import { z } from "zod";
import { config, type GeminiModelId, type StageModelChoice } from "../config.js";

/**
 * Server-side model catalog — the single source of truth for which models a run
 * may use (Layer 2 of the multi-LLM plan). The UI renders buttons from this list
 * via `GET /v1/models`; the server controls which models (and therefore which
 * keys/costs) are allowed. A run stores a catalog `id`; `createProviderForStage`
 * resolves it back to a concrete provider.
 *
 * Adding a model = one entry here or via JANTRA_MODEL_CATALOG_PATH. No pipeline/agent code changes.
 */

export type CatalogProvider = "gemini" | "openai-compatible";

export const catalogModelSchema = z.object({
  id: z.string().min(1).max(96),
  label: z.string().min(1).max(96),
  provider: z.enum(["gemini", "openai-compatible"]),
  model: z.string().min(1).max(128),
  tier: z.enum(["flash", "pro"]),
  supportsTools: z.boolean(),
});

export const catalogSchema = z.array(catalogModelSchema).min(1);

export type CatalogModel = z.infer<typeof catalogModelSchema>;

/**
 * Curated built-in list of selectable models. OpenAI-compatible entries assume the
 * default OpenRouter route (`JANTRA_BASE_URL`); switch hosts by changing that
 * env var. Gemini entries run directly against the Gemini API.
 */
export const BUILTIN_MODEL_CATALOG: readonly CatalogModel[] = [
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

export function loadModelCatalog(catalogPath?: string): CatalogModel[] {
  if (!catalogPath) {
    return [...BUILTIN_MODEL_CATALOG];
  }
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Configured model catalog file was not found: ${catalogPath}`);
  }
  const raw = fs.readFileSync(catalogPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Model catalog at ${catalogPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return catalogSchema.parse(parsed);
}

export let MODEL_CATALOG: readonly CatalogModel[] = loadModelCatalog(config.modelCatalogPath);

export function reloadModelCatalog(catalogPath?: string): readonly CatalogModel[] {
  MODEL_CATALOG = loadModelCatalog(catalogPath ?? config.modelCatalogPath);
  return MODEL_CATALOG;
}

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

export async function checkCatalogModels(
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): Promise<string[]> {
  const unlisted: string[] = [];
  if (config.provider === "openai-compatible" && config.baseUrl && config.llmApiKey) {
    try {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.llmApiKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        const available = new Set(body.data?.map((m) => m.id) ?? []);
        for (const item of catalog) {
          if (item.provider === "openai-compatible" && !available.has(item.model)) {
            unlisted.push(item.id);
            console.warn(
              `[jantra] Catalog model "${item.id}" (${item.model}) was not listed by ${config.baseUrl}`,
            );
          }
        }
      }
    } catch {}
  }
  return unlisted;
}

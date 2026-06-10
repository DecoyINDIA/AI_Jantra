import "dotenv/config";

export type StageModelChoice = "flash" | "pro";
export type GeminiModelId = "gemini-2.5-flash" | "gemini-2.5-pro";

const MODEL_IDS: Record<StageModelChoice, GeminiModelId> = {
  flash: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
};

function modelChoiceFromEnv(name: string, fallback: StageModelChoice): StageModelChoice {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === "flash" || raw === "pro") return raw;
  throw new Error(`${name} must be "flash" or "pro". Received "${raw}".`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number. Received "${raw}".`);
  }
  return value;
}

function thinkingBudgetFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -1) {
    throw new Error(`${name} must be an integer >= -1. Received "${raw}".`);
  }
  return value;
}

function boundedIntegerFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Math.trunc(numberFromEnv(name, fallback));
  return Math.min(max, Math.max(min, value));
}

export type ProviderId = "gemini" | "mock" | "openai-compatible";

function providerFromEnv(): ProviderId {
  const raw = process.env.JANTRA_PROVIDER ?? "gemini";
  if (raw === "gemini" || raw === "mock" || raw === "openai-compatible") return raw;
  throw new Error(
    `JANTRA_PROVIDER must be "gemini", "mock", or "openai-compatible". Received "${raw}".`,
  );
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean-like value. Received "${raw}".`);
}

export const config = {
  provider: providerFromEnv(),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  // OpenAI-compatible provider (OpenRouter by default). Used when
  // JANTRA_PROVIDER=openai-compatible. Switch models with JANTRA_MODEL alone.
  baseUrl: (process.env.JANTRA_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  llmApiKey: process.env.JANTRA_API_KEY ?? "",
  llmModelFlash: process.env.JANTRA_MODEL ?? "",
  llmModelPro: process.env.JANTRA_MODEL_PRO ?? process.env.JANTRA_MODEL ?? "",
  llmPriceInputPerMillion: numberFromEnv("JANTRA_PRICE_INPUT", 0),
  llmPriceOutputPerMillion: numberFromEnv("JANTRA_PRICE_OUTPUT", 0),
  mockFixturePath:
    process.env.JANTRA_MOCK_FIXTURE ?? "src/runtime/evals/fixtures/transcript.json",
  explicitCache: booleanFromEnv("JANTRA_EXPLICIT_CACHE", true),
  auditDir: process.env.JANTRA_AUDIT_DIR ?? ".jantra/audit",
  auditMaxFieldBytes: Math.trunc(numberFromEnv("JANTRA_AUDIT_MAX_FIELD_BYTES", 16 * 1024)),
  projectDir: process.env.JANTRA_PROJECT_DIR ?? ".jantra/projects",
  maxSteps: Math.trunc(numberFromEnv("JANTRA_MAX_STEPS", 16)),
  maxUserMessageChars: Math.trunc(numberFromEnv("JANTRA_MAX_USER_MESSAGE_CHARS", 100_000)),
  maxEvalRounds: Math.trunc(numberFromEnv("JANTRA_MAX_EVAL_ROUNDS", 2)),
  maxOutputTokens: Math.trunc(numberFromEnv("JANTRA_MAX_OUTPUT_TOKENS", 12000)),
  thinkingBudget: thinkingBudgetFromEnv("JANTRA_THINKING_BUDGET", 4096),
  costCeilingUsd: numberFromEnv("JANTRA_COST_CEILING_USD", 10),
  intakeRunCeilingUsd: numberFromEnv("JANTRA_INTAKE_RUN_CEILING_USD", 0.25),
  intakeClientDailyCeilingUsd: numberFromEnv(
    "JANTRA_INTAKE_CLIENT_DAILY_CEILING_USD",
    0.5,
  ),
  researchConcurrency: boundedIntegerFromEnv("JANTRA_RESEARCH_CONCURRENCY", 4, 1, 8),
  synthesisConcurrency: boundedIntegerFromEnv("JANTRA_SYNTHESIS_CONCURRENCY", 3, 1, 6),
  maxSources: boundedIntegerFromEnv("JANTRA_MAX_SOURCES", 24, 1, 48),
};

export function requireApiKey(): void {
  if (config.provider === "mock") return;
  if (config.provider === "openai-compatible") {
    if (!config.llmApiKey) {
      throw new Error(
        "JANTRA_API_KEY is not set. Required when JANTRA_PROVIDER=openai-compatible.",
      );
    }
    if (!config.llmModelFlash) {
      throw new Error(
        "JANTRA_MODEL is not set. Required when JANTRA_PROVIDER=openai-compatible.",
      );
    }
    // Grounded research calls still run on Gemini (hybrid). Warn but do not block;
    // the GeminiProvider will raise a clear error if a grounded call is attempted.
    if (!config.geminiApiKey) {
      console.warn(
        "[jantra] GEMINI_API_KEY is not set; grounded research will fail until it is provided.",
      );
    }
    // Cost ceilings depend on per-call cost. When no static pricing is set we
    // rely on the endpoint returning usage.cost (OpenRouter does with accounting
    // on). If it does not, every call would cost $0.00 and every ceiling (run,
    // intake, daily) becomes a silent no-op. Warn loudly so this is not missed.
    if (
      config.llmPriceInputPerMillion === 0 &&
      config.llmPriceOutputPerMillion === 0
    ) {
      console.warn(
        "[jantra] JANTRA_PRICE_INPUT/JANTRA_PRICE_OUTPUT are both 0. Cost ceilings will only work if the endpoint returns per-call usage.cost; otherwise calls will be billed at $0.00 and ceilings will not trigger. Set explicit per-million pricing to be safe.",
      );
    }
    return;
  }
  if (!config.geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
}

function envKeyPart(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function resolveStageModel(
  agentId: string,
  stageId: string,
  fallback: StageModelChoice,
): StageModelChoice {
  const scoped = `JANTRA_MODEL_${envKeyPart(agentId)}_${envKeyPart(stageId)}`;
  const legacy = `JANTRA_MODEL_${envKeyPart(stageId)}`;
  return modelChoiceFromEnv(scoped, modelChoiceFromEnv(legacy, fallback));
}

export function getModelId(choice: StageModelChoice): GeminiModelId {
  return MODEL_IDS[choice];
}

export function getModelIdForStage(
  stageId: string,
  fallback: StageModelChoice = "flash",
  agentId = "planning-pipeline",
): GeminiModelId {
  return getModelId(resolveStageModel(agentId, stageId, fallback));
}

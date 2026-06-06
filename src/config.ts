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

function providerFromEnv(): "gemini" | "mock" {
  const raw = process.env.JANTRA_PROVIDER ?? "gemini";
  if (raw === "gemini" || raw === "mock") return raw;
  throw new Error(`JANTRA_PROVIDER must be "gemini" or "mock". Received "${raw}".`);
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
  if (config.provider !== "mock" && !config.geminiApiKey) {
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

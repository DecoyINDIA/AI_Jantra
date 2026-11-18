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

export type DataCollectionPolicy = "deny" | "allow";

/**
 * Optional OpenRouter data-governance policy. When set, outgoing OpenAI-
 * compatible calls restrict routing to providers honoring the policy:
 * "deny" routes only to providers that do not store or train on inputs.
 * Omitted by default so behavior is unchanged unless explicitly opted in.
 */
function dataCollectionFromEnv(): DataCollectionPolicy | undefined {
  const raw = process.env.JANTRA_DATA_COLLECTION;
  if (!raw) return undefined;
  if (raw === "deny" || raw === "allow") return raw;
  throw new Error(
    `JANTRA_DATA_COLLECTION must be "deny" or "allow". Received "${raw}".`,
  );
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean-like value. Received "${raw}".`);
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveDataDirs(env: Record<string, string | undefined>): {
  dataDir: string;
  auditDir: string;
  projectDir: string;
  leadDir: string;
  opsDataDir: string;
} {
  const dataDir = env.JANTRA_DATA_DIR || ".jantra";
  const trimmed = dataDir.replace(/[\\/]+$/, "");
  function dirFromEnv(name: string, sub: string): string {
    return env[name] || `${trimmed}/${sub}`;
  }
  return {
    dataDir,
    auditDir: dirFromEnv("JANTRA_AUDIT_DIR", "audit"),
    projectDir: dirFromEnv("JANTRA_PROJECT_DIR", "projects"),
    leadDir: dirFromEnv("JANTRA_LEAD_DIR", "leads"),
    opsDataDir: dirFromEnv("JANTRA_OPS_DATA_DIR", "ops"),
  };
}

const dataDirs = resolveDataDirs(process.env);

export const config = {
  // Raw key:clientId[:subject] records; parsed in src/server/auth/apiKeys.ts.
  remoteApiKeysRaw: process.env.JANTRA_REMOTE_API_KEYS ?? "",
  // Server entry points (src/server/index.ts local, src/server/remote.ts hosted).
  serverHost: process.env.JANTRA_SERVER_HOST ?? "0.0.0.0",
  // Concurrent SSE streams; each holds a socket, a timer and a listener.
  sseMaxPerIdentity: Math.trunc(numberFromEnv("JANTRA_SSE_MAX_PER_IDENTITY", 10)),
  sseMaxTotal: Math.trunc(numberFromEnv("JANTRA_SSE_MAX_TOTAL", 500)),
  // Peer addresses whose X-Forwarded-For is believed (proxy-addr syntax:
  // presets loopback/linklocal/uniquelocal, or CIDRs). The default covers
  // platform proxies on private networks, including CGNAT ranges.
  trustedProxies: (process.env.JANTRA_TRUSTED_PROXIES ?? "loopback,linklocal,uniquelocal,100.64.0.0/10")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  serverPort: process.env.JANTRA_SERVER_PORT ? Number(process.env.JANTRA_SERVER_PORT) : 4317,
  loopbackToken: process.env.JANTRA_LOOPBACK_TOKEN ?? "",
  localAllowedOrigins: (process.env.JANTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  adminToken: process.env.JANTRA_ADMIN_TOKEN ?? "",
  defaultClientId: process.env.JANTRA_CLIENT_ID ?? "xolver",
  // Logto (end-user identity for leads); overridable for non-prod tenants.
  logtoIssuer: process.env.JANTRA_LOGTO_ISSUER ?? "https://auth.xolver.in/oidc",
  logtoAudience: process.env.JANTRA_LOGTO_AUDIENCE ?? "https://api.jantra.in",
  logtoJwksUrl: process.env.JANTRA_LOGTO_JWKS_URL ?? "https://auth.xolver.in/oidc/jwks",
  // Firebnb concierge tool backend (operator-configured, not caller-supplied).
  firebnbFunctionsUrl: process.env.FIREBNB_FUNCTIONS_URL || "http://127.0.0.1:54321/functions/v1",
  firebnbServiceToken: process.env.JANTRA_FIREBNB_SERVICE_TOKEN || "",
  // Shared secret the Cloudflare edge sends as X-Jantra-Edge-Secret. When set,
  // public-scope requests without it are refused, so a leaked public key cannot
  // be used against the origin directly.
  edgeSharedSecret: process.env.JANTRA_EDGE_SECRET ?? "",
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
  // OpenRouter data-governance policy. Undefined by default (no behavior
  // change); set JANTRA_DATA_COLLECTION=deny to forbid providers that train
  // on inputs. Ignored by non-OpenRouter endpoints.
  dataCollection: dataCollectionFromEnv(),
  mockFixturePath:
    process.env.JANTRA_MOCK_FIXTURE ?? "src/runtime/evals/fixtures/transcript.json",
  explicitCache: booleanFromEnv("JANTRA_EXPLICIT_CACHE", true),
  opsAllowSynthetic: booleanFromEnv("JANTRA_OPS_ALLOW_SYNTHETIC", false),
  publicSubjects: listFromEnv("JANTRA_PUBLIC_SUBJECTS", ["web"]),
  publicAgentIds: listFromEnv("JANTRA_PUBLIC_AGENT_IDS", [
    "intake-public",
    "firebnb-concierge",
  ]),
  dataDir: dataDirs.dataDir,
  auditDir: dataDirs.auditDir,
  // Key for HMAC-chaining audit lines. Keep it off the audit disk; without it
  // the chain is plain SHA-256 (detects damage, not a determined writer).
  auditHmacKey: process.env.JANTRA_AUDIT_HMAC_KEY ?? "",
  auditMaxFieldBytes: Math.trunc(numberFromEnv("JANTRA_AUDIT_MAX_FIELD_BYTES", 16 * 1024)),
  projectDir: dataDirs.projectDir,
  leadDir: dataDirs.leadDir,
  opsDataDir: dataDirs.opsDataDir,
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
  intakeVisitorDailyCeilingUsd: numberFromEnv(
    "JANTRA_INTAKE_VISITOR_DAILY_CEILING_USD",
    0.1,
  ),
  opsOnboardCeilingUsd: numberFromEnv("JANTRA_OPS_ONBOARD_CEILING_USD", 2.00),
  opsReportCeilingUsd: numberFromEnv("JANTRA_OPS_REPORT_CEILING_USD", 1.50),
  opsClientDailyCeilingUsd: numberFromEnv("JANTRA_OPS_DAILY_CEILING_USD", 5.00),
  gatewayRunCeilingUsd: numberFromEnv("JANTRA_GATEWAY_RUN_CEILING_USD", 0.05),
  gatewayClientDailyCeilingUsd: numberFromEnv("JANTRA_GATEWAY_DAILY_CEILING_USD", 2.0),
  allowUnpricedModels: booleanFromEnv("JANTRA_ALLOW_UNPRICED_MODELS", false),
  // Remote-surface request rate limit (fixed window, per client IP). Applies
  // only in remote mode; the loopback-only local API is not throttled. Defaults
  // to 120 requests / 60s. Set max to 0 via env to effectively disable.
  rateLimitWindowMs: Math.trunc(numberFromEnv("JANTRA_RATE_LIMIT_WINDOW_MS", 60_000)),
  rateLimitMax: Math.trunc(numberFromEnv("JANTRA_RATE_LIMIT_MAX", 120)),
  publicVisitorRateLimitMax: Math.trunc(
    numberFromEnv("JANTRA_PUBLIC_VISITOR_RATE_LIMIT_MAX", 30),
  ),
  researchConcurrency: boundedIntegerFromEnv("JANTRA_RESEARCH_CONCURRENCY", 4, 1, 8),
  synthesisConcurrency: boundedIntegerFromEnv("JANTRA_SYNTHESIS_CONCURRENCY", 3, 1, 6),
  maxSources: boundedIntegerFromEnv("JANTRA_MAX_SOURCES", 24, 1, 48),
  modelCatalogPath: process.env.JANTRA_MODEL_CATALOG_PATH || undefined,
  leadRetentionDays: boundedIntegerFromEnv("JANTRA_LEAD_RETENTION_DAYS", 30, 1, 365),
  enableLeadDeletionSweep: booleanFromEnv("JANTRA_ENABLE_LEAD_DELETION_SWEEP", false),
  leadDeleteLinkedRuns: booleanFromEnv("JANTRA_LEAD_DELETE_LINKED_RUNS", false),
  runLiveJudge: booleanFromEnv("JANTRA_RUN_LIVE_JUDGE", false),
  secretsKey: process.env.JANTRA_SECRETS_KEY ?? "",
  licensePublicKey: process.env.JANTRA_LICENSE_PUBLIC_KEY || undefined,
  licensePath: process.env.JANTRA_LICENSE_PATH || undefined,
  licenseToken: process.env.JANTRA_LICENSE_TOKEN || undefined,
  licenseEnforcement: booleanFromEnv("JANTRA_LICENSE_ENFORCEMENT", false),
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

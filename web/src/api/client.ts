export interface StageDefinitionView {
  id: string;
  title: string;
  description: string;
  kind: string;
  runnerKind: string;
  model: "flash" | "pro";
  artifactKinds: string[];
  gate: "human" | "auto" | "disabled";
  interactionMode: "none" | "reentrant";
  enabled: boolean;
  toolNames?: string[];
}

export interface AgentDefinitionView {
  id: string;
  name: string;
  description: string;
  version: number;
  clientScoped: true;
  stages: StageDefinitionView[];
}

export interface AgentDefinitionSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  stageCount: number;
}

export interface EvalScore {
  rubric: string;
  scores: Record<string, number>;
  passed: boolean;
  notes: string;
}

export interface ArtifactView {
  stage: string;
  kind: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  eval?: EvalScore;
}

export interface StageView {
  id: string;
  status: string;
  artifacts: ArtifactView[];
  evals: EvalScore[];
  updatedAt: string;
}

export interface PendingInteractionView {
  id: string;
  runId: string;
  stageId: string;
  kind: "question" | "approval";
  prompt: string;
  status: "pending" | "answered" | "cancelled";
  toolName?: string;
  input?: unknown;
  createdAt: string;
}

export interface SourceView {
  id: string;
  clientId: string;
  url: string;
  title: string;
  retrievedAt: string;
  contentHash: string;
  qualityScore: number;
  contentPath?: string;
}

export interface CostRollupView {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  groundedPrompts: number;
  perStage: Record<string, Omit<CostRollupView, "perStage">>;
}

export interface RunDetail {
  id: string;
  title: string;
  clientId: string;
  agentId: string;
  agentVersion: number;
  agentDefinitionSnapshot: {
    id: string;
    name: string;
    description: string;
    version: number;
    stages: StageDefinitionView[];
    stageOrder: string[];
    activeStageOrder: string[];
    snapshotHash: string;
  };
  status: "active" | "completed" | "abandoned";
  currentStage: string;
  stages: Record<string, StageView>;
  sources: SourceView[];
  interactions: PendingInteractionView[];
  cost: CostRollupView;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  title: string;
  clientId: string;
  agentId: string;
  agentVersion: number;
  status: string;
  currentStage: string;
  currentStageStatus: string;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: string;
  cursor: string;
  runId: string;
  ts: string;
  type: string;
  stage?: string;
  message: string;
  data: Record<string, unknown>;
}

export interface AuditEntry {
  ts: string;
  runId: string;
  type: string;
  clientId?: string;
  [key: string]: unknown;
}

export interface ApiConfig {
  baseUrl: string;
  token: string;
  adminToken: string;
}

export interface ApiKeyMetadata {
  id: string;
  prefix: string;
  clientId: string;
  subject: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(body || `HTTP ${status}`);
  }
}

declare global {
  interface Window {
    JANTRA_DESKTOP?: Partial<ApiConfig>;
  }
}

const API_BASE_KEY = "jantra.api.baseUrl";
const API_TOKEN_KEY = "jantra.api.loopbackToken";
const API_ADMIN_TOKEN_KEY = "jantra.api.adminToken";

function firstConfigured(...values: Array<string | undefined | null>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

export function getApiConfig(): ApiConfig {
  const desktop = window.JANTRA_DESKTOP ?? {};
  return {
    baseUrl: firstConfigured(
      desktop.baseUrl,
      localStorage.getItem(API_BASE_KEY),
      import.meta.env.VITE_JANTRA_API_BASE_URL,
      "http://127.0.0.1:4317",
    ),
    token: firstConfigured(
      desktop.token,
      localStorage.getItem(API_TOKEN_KEY),
      import.meta.env.VITE_JANTRA_LOOPBACK_TOKEN,
    ),
    adminToken: firstConfigured(
      desktop.adminToken,
      localStorage.getItem(API_ADMIN_TOKEN_KEY),
      import.meta.env.VITE_JANTRA_ADMIN_TOKEN,
    ),
  };
}

export function saveApiConfig(config: ApiConfig): void {
  localStorage.setItem(API_BASE_KEY, config.baseUrl.replace(/\/$/, ""));
  localStorage.setItem(API_TOKEN_KEY, config.token);
  localStorage.setItem(API_ADMIN_TOKEN_KEY, config.adminToken);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getApiConfig();
  const headers = new Headers(init.headers);
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getApiConfig();
  const headers = new Headers(init.headers);
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
  if (config.adminToken) headers.set("x-jantra-admin-token", config.adminToken);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  listAgents: () => apiFetch<{ agents: AgentDefinitionSummary[] }>("/v1/agents"),
  getAgent: (agentId: string) => apiFetch<{ agent: AgentDefinitionView }>(`/v1/agents/${agentId}`),
  createRun: (body: { agentId: string; title: string; input?: string }) =>
    apiFetch<{ run: RunDetail }>("/v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listRuns: (query = "") => apiFetch<{ items: RunSummary[]; nextCursor?: string }>(`/v1/runs${query}`),
  getRun: (runId: string) => apiFetch<{ run: RunDetail }>(`/v1/runs/${runId}`),
  advanceRun: (runId: string) =>
    apiFetch<{ run: RunDetail; step: unknown }>(`/v1/runs/${runId}/advance`, {
      method: "POST",
    }),
  confirmRun: (runId: string) =>
    apiFetch<{ run: RunDetail; nextStage: string | null }>(`/v1/runs/${runId}/confirm`, {
      method: "POST",
    }),
  rejectRun: (runId: string, reason: string) =>
    apiFetch<{ run: RunDetail }>(`/v1/runs/${runId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  listInteractions: (runId: string) =>
    apiFetch<{ interactions: PendingInteractionView[] }>(`/v1/runs/${runId}/interactions`),
  answerInteraction: (runId: string, interactionId: string, body: { text?: string; approved?: boolean }) =>
    apiFetch<{ run: RunDetail; step: unknown }>(`/v1/runs/${runId}/interactions/${interactionId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getArtifact: (runId: string, artifactId: string) =>
    apiFetch<{ artifact: ArtifactView }>(`/v1/runs/${runId}/artifacts/${artifactId}`),
  listSources: (runId: string) => apiFetch<{ sources: SourceView[] }>(`/v1/runs/${runId}/sources`),
  getAudit: (runId: string, cursor?: string) =>
    apiFetch<{ items: AuditEntry[]; nextCursor?: string }>(
      `/v1/runs/${runId}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  createApiKey: (body: { label: string; clientId: string; subject: string }) =>
    adminFetch<{ key: string; apiKey: ApiKeyMetadata }>("/v1/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listApiKeys: (query = "") =>
    adminFetch<{ items: ApiKeyMetadata[] }>(`/v1/admin/keys${query}`),
  revokeApiKey: (id: string) =>
    adminFetch<{ apiKey: ApiKeyMetadata }>(`/v1/admin/keys/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }),
};

import type { AuditLogger } from "../audit.js";
import type {
  AgentDefinitionSnapshot,
  StageDefinitionSnapshot,
} from "../agents/definition.js";
import type { ModelMessage, ModelProvider } from "../model/provider.js";

export type StageId = string;

export type StageStatus =
  | "pending"
  | "in_progress"
  | "awaiting_input"
  | "awaiting_confirmation"
  | "confirmed"
  | "rejected"
  | "skipped";

export type ArtifactKind = string;

export interface EvalScore {
  rubric: string;
  scores: Record<string, number>;
  passed: boolean;
  notes: string;
}

export interface Artifact {
  stage: StageId;
  kind: ArtifactKind;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  eval?: EvalScore;
}

export interface Source {
  id: string;
  clientId: string;
  url: string;
  title: string;
  retrievedAt: string;
  contentHash: string;
  qualityScore: number;
  contentPath?: string;
}

export interface ClaimCitation {
  sourceId: string;
  quote: string;
}

export interface Claim {
  text: string;
  citations: ClaimCitation[];
  sourceIds: string[];
  verified: boolean;
  support: "verified" | "unverified";
}

export interface StageState {
  id: StageId;
  status: StageStatus;
  artifacts: Artifact[];
  evals: EvalScore[];
  updatedAt: string;
}

export interface StageCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  groundedPrompts: number;
}

export type CostRollup = StageCost & {
  perStage: Record<string, StageCost>;
};

export interface Project {
  id: string;
  title: string;
  clientId: string;
  agentId: string;
  agentVersion: number;
  agentDefinitionSnapshot: AgentDefinitionSnapshot;
  status: "active" | "completed" | "abandoned";
  currentStage: StageId;
  stages: Record<string, StageState>;
  sources: Source[];
  claims: Claim[];
  interactions: PendingInteraction[];
  execution: Record<string, PersistedStageState>;
  cost: CostRollup;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListQuery {
  clientId: string;
  agentId?: string;
  status?: Project["status"];
  currentStage?: string;
  limit?: number;
  cursor?: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  clientId: string;
  agentId: string;
  agentVersion: number;
  status: Project["status"];
  currentStage: string;
  currentStageStatus: StageStatus;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPage {
  items: ProjectSummary[];
  nextCursor?: string;
}

export type InteractionKind = "question" | "approval";
export type InteractionStatus = "pending" | "answered" | "cancelled";

export interface PendingInteraction {
  id: string;
  runId: string;
  stageId: string;
  kind: InteractionKind;
  prompt: string;
  status: InteractionStatus;
  toolName?: string;
  input?: unknown;
  createdAt: string;
  answeredAt?: string;
  response?: InteractionResponse;
}

export interface InteractionResponse {
  interactionId: string;
  text?: string;
  approved?: boolean;
}

export interface PersistedStageState {
  stageId: string;
  runnerKind: string;
  step: number;
  messages: ModelMessage[];
  pendingInteractionId?: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface StageIO {
  say(message: string): void;
  ask(question: string): Promise<string>;
}

export interface StageContext {
  project: Project;
  stageId: StageId;
  stageDefinition: StageDefinitionSnapshot;
  audit: AuditLogger;
  provider: ModelProvider;
  io: StageIO;
}

export type StageRunner = (ctx: StageContext) => Promise<Artifact[]>;

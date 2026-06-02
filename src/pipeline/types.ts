import type Anthropic from "@anthropic-ai/sdk";
import type { AuditLogger } from "../audit.js";

/** The four stages, in order. */
export type StageId = "intake" | "research" | "planning" | "build";

export const STAGE_ORDER: StageId[] = ["intake", "research", "planning", "build"];

export const STAGE_TITLES: Record<StageId, string> = {
  intake: "Intake",
  research: "Research",
  planning: "Planning",
  build: "Build",
};

export type StageStatus =
  | "pending"
  | "in_progress"
  | "awaiting_confirmation"
  | "confirmed"
  | "skipped";

/** A document produced by a stage. Markdown, versioned, timestamped. */
export interface Artifact {
  stage: StageId;
  /** e.g. "idea_summary", "research_report", "prd", "trd", "build_plan". */
  kind: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
}

export interface StageState {
  id: StageId;
  status: StageStatus;
  artifacts: Artifact[];
  updatedAt: string;
}

/** One client engagement flowing through the pipeline. Scoped by clientId. */
export interface Project {
  id: string;
  title: string;
  /** Multi-tenant-ready: everything is scoped by client. Single-tenant for now. */
  clientId: string;
  status: "active" | "completed" | "abandoned";
  currentStage: StageId;
  stages: Record<StageId, StageState>;
  createdAt: string;
  updatedAt: string;
}

/** How a stage talks to whoever is driving it (CLI now, Slack/web later). */
export interface StageIO {
  say(message: string): void;
  ask(question: string): Promise<string>;
}

/** Everything a stage runner needs to do its job. */
export interface StageContext {
  project: Project;
  audit: AuditLogger;
  client: Anthropic;
  io: StageIO;
}

/** A stage takes context and returns the artifact(s) it produced. */
export type StageRunner = (ctx: StageContext) => Promise<Artifact[]>;

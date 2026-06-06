import type { AuditLogger } from "./audit.js";

/**
 * Risk class for a tool. Drives the default policy: read runs freely, write and
 * sensitive actions are gated. Reversibility is the deciding heuristic.
 */
export type Risk = "read" | "write" | "sensitive";

/** What a tool hands back to the agent loop. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Context passed to every tool execution. */
export interface ToolContext {
  runId: string;
  audit: AuditLogger;
  /** A tool sets this to stop the loop and hand the task to a person. */
  requestHandoff: (reason: string, summary: string) => void;
}

/**
 * A capability the agent can use. The same shape works for every vertical
 * (support, revenue, ops); only the set of tools changes per agent.
 */
export interface ToolDef<I = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
  risk: Risk;
  run: (input: I, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/**
 * A tool with its input type erased. Tools with different input shapes coexist
 * in one registry, so the collection is typed over this rather than a single I.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

/** A policy decision for one attempted tool call. */
export type Decision = "allow" | "ask" | "deny";

export interface PolicyVerdict {
  decision: Decision;
  /** Human-readable reason, recorded in the audit trail. */
  reason: string;
}

/** The guardrail gate. Pure and synchronous: easy to test and to reason about. */
export interface Policy {
  decide(tool: ToolDef, input: unknown): PolicyVerdict;
}

/** Called when a gated action needs sign-off. Returns true to allow. */
export type ApprovalHandler = (req: {
  runId: string;
  toolName: string;
  input: unknown;
  reason: string;
}) => Promise<boolean>;

/** Called when the agent hands the task to a human. */
export type HandoffHandler = (req: {
  runId: string;
  reason: string;
  summary: string;
}) => Promise<void> | void;

/** Definition of an agent: who it is, what it can do, how it behaves. */
export interface AgentSpec {
  name: string;
  /** Frozen system prompt, kept byte-stable so the prompt cache stays warm. */
  systemPrompt: string;
  /** Gemini 2.5 thinking token budget. Use -1 only for explicitly dynamic runs. */
  thinkingBudget?: number;
  /** Stable order matters for prompt caching; do not sort at request time. */
  tools: AnyTool[];
}

export interface RunResult {
  runId: string;
  /** The agent's final message to the user, if it finished on its own. */
  finalText: string | null;
  /** True if the task was handed to a human instead of completed. */
  handedOff: boolean;
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    thinkingTokens: number;
    costUsd: number;
  };
}

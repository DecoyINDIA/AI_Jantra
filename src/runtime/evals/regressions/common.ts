import { readFileSync } from "node:fs";
import { config, type GeminiModelId } from "../../../config.js";
import type {
  GenerateOptions,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ToolCall,
} from "../../../model/provider.js";
import { RuleBasedPolicy, type PolicyConfig } from "../../../policy.js";
import type { Policy } from "../../../types.js";
import type { StageEvalResult } from "../report.js";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function readAuditJsonl(runId: string): Array<Record<string, unknown>> {
  return readFileSync(`${config.auditDir}/${runId}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export const usage: ModelUsage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  thinkingTokens: 0,
  totalTokens: 2,
  groundedPrompts: 0,
};

export function result(
  text: string,
  toolCalls: ToolCall[] = [],
  modelId: GeminiModelId = "gemini-2.5-flash",
): ModelResult {
  const content = toolCalls.length
    ? toolCalls.map((call) => ({
        type: "functionCall" as const,
        id: call.id,
        name: call.name,
        args: call.args,
      }))
    : text;
  return {
    provider: "mock",
    modelId,
    text,
    message: { role: "model", content },
    toolCalls,
    citations: [],
    usage,
    costUsd: 0,
    latencyMs: 0,
  };
}

export class SequenceProvider implements ModelProvider {
  readonly id: GeminiModelId = "gemini-2.5-flash";
  private index = 0;
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly results: ModelResult[]) {}

  async generate(opts: GenerateOptions): Promise<ModelResult> {
    this.requests.push(opts);
    const next = this.results[this.index++];
    if (!next) throw new Error("SequenceProvider had no remaining result.");
    return next;
  }
}

export function deniedPolicy(): Policy {
  const cfg: PolicyConfig = {
    byRisk: { read: "allow", write: "ask", sensitive: "ask" },
    denyWhen: [
      {
        tool: "lookup",
        predicate: (_tool, input) =>
          typeof input === "object" &&
          input !== null &&
          "blocked" in input &&
          input.blocked === true,
        reason: "Blocked lookup argument.",
      },
      {
        tool: "search_knowledge_base",
        predicate: (_tool, input) =>
          typeof input === "object" &&
          input !== null &&
          "query" in input &&
          input.query === "blocked",
        reason: "Blocked support query.",
      },
    ],
  };
  return new RuleBasedPolicy(cfg);
}

export async function runRegression(
  fixtureId: string,
  fn: () => Promise<void> | void,
): Promise<StageEvalResult> {
  try {
    await fn();
    return {
      fixtureId,
      stage: "regression",
      score: 5,
      passed: true,
      notes: "Regression check passed.",
    };
  } catch (err) {
    return {
      fixtureId,
      stage: "regression",
      score: 1,
      passed: false,
      notes: err instanceof Error ? err.message : String(err),
    };
  }
}

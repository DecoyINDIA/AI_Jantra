import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { GeminiModelId } from "../config.js";
import { ModelProviderError, SchemaValidationError } from "../runtime/errors.js";
import type {
  GenerateOptions,
  GroundingCitation,
  ModelContentPart,
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ToolCall,
} from "./provider.js";

const DEFAULT_USAGE = {
  inputTokens: 10,
  outputTokens: 10,
  cachedTokens: 0,
  thinkingTokens: 0,
  totalTokens: 20,
  groundedPrompts: 0,
};

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(10),
  outputTokens: z.number().int().nonnegative().default(10),
  cachedTokens: z.number().int().nonnegative().default(0),
  thinkingTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(20),
  groundedPrompts: z.number().int().nonnegative().default(0),
});

const toolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

const citationSchema = z.object({
  uri: z.string().min(1),
  title: z.string().min(1),
  segmentText: z.string().optional(),
  confidence: z.number().optional(),
});

const fixtureEntrySchema = z.object({
  stage: z.string().min(1),
  purpose: z.string().min(1),
  text: z.string().default(""),
  toolCalls: z.array(toolCallSchema).default([]),
  citations: z.array(citationSchema).default([]),
  thinking: z.string().optional(),
  usage: usageSchema.default(DEFAULT_USAGE),
});

const fixtureSchema = z.object({
  entries: z.array(fixtureEntrySchema).min(1),
});

type MockFixtureEntry = z.infer<typeof fixtureEntrySchema>;

function resultMessage(text: string, toolCalls: ToolCall[]): ModelMessage {
  const parts: ModelContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(
    ...toolCalls.map((call) => ({
      type: "functionCall" as const,
      id: call.id,
      name: call.name,
      args: call.args,
    })),
  );
  return parts.length ? { role: "model", content: parts } : { role: "model", content: "" };
}

function resolveFixtureUri(uri: string, fixtureDir: string): string {
  const fixtureDirUrl = pathToFileURL(fixtureDir).href.replace(/\/$/, "");
  return uri.replaceAll("{{fixtureDir}}", fixtureDirUrl);
}

function usageFor(entry: MockFixtureEntry, opts: GenerateOptions): ModelUsage {
  return {
    ...entry.usage,
    groundedPrompts: opts.grounding ? Math.max(1, entry.usage.groundedPrompts) : entry.usage.groundedPrompts,
  };
}

export class MockProvider implements ModelProvider {
  private readonly entries: MockFixtureEntry[];
  private readonly fixtureDir: string;
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly stage: string,
    readonly id: GeminiModelId,
    fixturePath: string,
  ) {
    const resolved = resolve(fixturePath);
    this.fixtureDir = dirname(resolved);
    const parsed = fixtureSchema.safeParse(JSON.parse(readFileSync(resolved, "utf8")));
    if (!parsed.success) {
      throw new SchemaValidationError("Mock provider fixture failed schema validation.", {
        issues: parsed.error.issues,
        fixturePath: resolved,
      });
    }
    this.entries = parsed.data.entries;
  }

  async generate(opts: GenerateOptions): Promise<ModelResult> {
    const purpose = opts.purpose ?? "default";
    const key = `${this.stage}:${purpose}`;
    const used = this.cursors.get(key) ?? 0;
    const matches = this.entries.filter(
      (entry) => entry.stage === this.stage && entry.purpose === purpose,
    );
    const entry = matches[used];
    if (!entry) {
      throw new ModelProviderError("Mock provider has no fixture entry for model call.", {
        stage: this.stage,
        purpose,
        used,
      });
    }
    this.cursors.set(key, used + 1);

    const toolCalls = entry.toolCalls.map((call) => ({ ...call }));
    const citations: GroundingCitation[] = entry.citations.map((citation) => ({
      ...citation,
      uri: resolveFixtureUri(citation.uri, this.fixtureDir),
    }));
    const usage = usageFor(entry, opts);
    return {
      provider: "mock",
      modelId: this.id,
      text: entry.text,
      message: resultMessage(entry.text, toolCalls),
      toolCalls,
      thinking: entry.thinking ?? `Mock ${this.stage} ${purpose}.`,
      citations,
      usage,
      costUsd: 0,
      latencyMs: 0,
      cache: opts.cacheKey
        ? {
            key: opts.cacheKey,
            status: "skipped",
            reason: "mock_provider",
          }
        : undefined,
    };
  }
}

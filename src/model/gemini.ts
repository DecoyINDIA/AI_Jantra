import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type Tool,
} from "@google/genai";

import type { GeminiModelId } from "../config.js";
import { config } from "../config.js";
import { ModelProviderError } from "../runtime/errors.js";
import type {
  GenerateOptions,
  GroundingCitation,
  ModelContentPart,
  ModelMessage,
  ModelResult,
  ModelUsage,
  ToolCall,
  ToolSpec,
} from "./provider.js";
import type { ModelProvider } from "./provider.js";

const SEARCH_GROUNDING_COST_USD = 35 / 1000;
const CACHE_MIN_TOKENS: Record<GeminiModelId, number> = {
  "gemini-2.5-flash": 1024,
  "gemini-2.5-pro": 4096,
};

const PRICE_TABLE: Record<
  GeminiModelId,
  {
    inputPerMillion: (inputTokens: number) => number;
    outputPerMillion: (inputTokens: number) => number;
    cachedPerMillion: (inputTokens: number) => number;
  }
> = {
  "gemini-2.5-flash": {
    inputPerMillion: () => 0.3,
    outputPerMillion: () => 2.5,
    cachedPerMillion: () => 0.03,
  },
  "gemini-2.5-pro": {
    inputPerMillion: (inputTokens) => (inputTokens <= 200_000 ? 1.25 : 2.5),
    outputPerMillion: (inputTokens) => (inputTokens <= 200_000 ? 10 : 15),
    cachedPerMillion: (inputTokens) => (inputTokens <= 200_000 ? 0.125 : 0.25),
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertSupportedCombination(opts: GenerateOptions): void {
  const hasTools = (opts.tools?.length ?? 0) > 0;
  if (opts.responseJsonSchema && (hasTools || opts.grounding)) {
    throw new ModelProviderError(
      "Gemini 2.5 does not support combining structured output with tools.",
      {
        hasTools,
        grounding: opts.grounding ?? false,
      },
    );
  }
  if (hasTools && opts.grounding) {
    throw new ModelProviderError(
      "Gemini 2.5 does not support combining custom function tools with Google Search grounding.",
    );
  }
}

function toFunctionDeclaration(tool: ToolSpec): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  };
}

function toGeminiPart(part: ModelContentPart): Part {
  switch (part.type) {
    case "text":
      return {
        text: part.text,
        thoughtSignature: part.thoughtSignature,
      };
    case "thought":
      return {
        text: part.text,
        thought: true,
        thoughtSignature: part.thoughtSignature,
      };
    case "functionCall":
      return {
        functionCall: {
          id: part.id,
          name: part.name,
          args: part.args,
        },
        thoughtSignature: part.thoughtSignature,
      };
    case "functionResponse":
      return {
        functionResponse: {
          id: part.id,
          name: part.name,
          response: part.response,
        },
      };
  }
  const _exhaustive: never = part;
  return _exhaustive;
}

function toGeminiContent(message: ModelMessage): Content {
  if (typeof message.content === "string") {
    return { role: message.role, parts: [{ text: message.content }] };
  }
  return {
    role: message.role,
    parts: message.content.map(toGeminiPart),
  };
}

function fromGeminiPart(part: Part): ModelContentPart | null {
  if (part.functionCall?.name) {
    return {
      type: "functionCall",
      id: part.functionCall.id,
      name: part.functionCall.name,
      args: part.functionCall.args ?? {},
      thoughtSignature: part.thoughtSignature,
    };
  }
  if (part.functionResponse?.name) {
    return {
      type: "functionResponse",
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: part.functionResponse.response ?? {},
    };
  }
  if (part.text) {
    return {
      type: part.thought ? "thought" : "text",
      text: part.text,
      thoughtSignature: part.thoughtSignature,
    };
  }
  return null;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "thought") return part.text;
      return JSON.stringify(part);
    })
    .join("\n");
}

function estimateTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + messageText(message).length, 0);
  return Math.ceil(chars / 4);
}

function buildConfig(opts: GenerateOptions, cachedContent?: string): GenerateContentConfig {
  const tools: Tool[] = [];
  if (opts.tools?.length) {
    tools.push({
      functionDeclarations: opts.tools.map(toFunctionDeclaration),
    });
  }
  if (opts.grounding) {
    tools.push({ googleSearch: {} });
  }

  const cfg: GenerateContentConfig = {
    systemInstruction: opts.system,
    maxOutputTokens: opts.maxOutputTokens ?? config.maxOutputTokens,
    temperature: opts.temperature ?? 0.2,
    thinkingConfig: opts.thinking
      ? {
          includeThoughts: true,
          thinkingBudget: opts.thinkingBudget ?? -1,
        }
      : undefined,
    tools: tools.length ? tools : undefined,
    cachedContent,
  };

  if (opts.responseJsonSchema) {
    cfg.responseMimeType = "application/json";
    cfg.responseJsonSchema = opts.responseJsonSchema;
  }

  if (opts.tools?.length) {
    cfg.toolConfig = {
      functionCallingConfig: {
        mode:
          opts.toolChoice === "required"
            ? FunctionCallingConfigMode.ANY
            : opts.toolChoice === "none"
              ? FunctionCallingConfigMode.NONE
              : FunctionCallingConfigMode.AUTO,
        allowedFunctionNames: opts.allowedToolNames,
      },
    };
  }

  return cfg;
}

function extractMessage(response: GenerateContentResponse): ModelMessage {
  const parts =
    response.candidates?.[0]?.content?.parts
      ?.map(fromGeminiPart)
      .filter((part): part is ModelContentPart => part !== null) ?? [];
  return { role: "model", content: parts };
}

function extractToolCalls(response: GenerateContentResponse): ToolCall[] {
  return (
    response.functionCalls
      ?.filter((call) => call.name)
      .map((call) => ({
        id: call.id,
        name: call.name as string,
        args: call.args ?? {},
      })) ?? []
  );
}

function extractThinking(response: GenerateContentResponse): string | undefined {
  const thoughts =
    response.candidates?.[0]?.content?.parts
      ?.filter((part) => part.thought && part.text)
      .map((part) => part.text as string) ?? [];
  const joined = thoughts.join("\n").trim();
  return joined || undefined;
}

function extractCitations(response: GenerateContentResponse): GroundingCitation[] {
  const metadata = response.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks ?? [];
  const supports = metadata?.groundingSupports ?? [];
  const citations = new Map<string, GroundingCitation>();

  for (const support of supports) {
    const indices = support.groundingChunkIndices ?? [];
    for (let pos = 0; pos < indices.length; pos++) {
      const chunk = chunks[indices[pos] ?? -1];
      const uri = chunk?.web?.uri;
      if (!uri) continue;
      const title = chunk.web?.title ?? uri;
      const segmentText = support.segment?.text;
      const key = `${uri}\n${segmentText ?? ""}`;
      citations.set(key, {
        uri,
        title,
        segmentText,
        confidence: support.confidenceScores?.[pos],
      });
    }
  }

  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    if (!uri) continue;
    const key = `${uri}\n`;
    if (!citations.has(key)) {
      citations.set(key, { uri, title: chunk.web?.title ?? uri });
    }
  }

  return [...citations.values()];
}

function usageFromResponse(
  response: GenerateContentResponse,
  grounded: boolean,
): ModelUsage {
  const usage = response.usageMetadata;
  const prompt = usage?.promptTokenCount ?? 0;
  const toolUse = usage?.toolUsePromptTokenCount ?? 0;
  const candidates = usage?.candidatesTokenCount ?? 0;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  return {
    inputTokens: prompt + toolUse,
    outputTokens: candidates + thoughts,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
    thinkingTokens: thoughts,
    totalTokens: usage?.totalTokenCount ?? prompt + toolUse + candidates + thoughts,
    groundedPrompts: grounded ? 1 : 0,
  };
}

export function calculateGeminiCostUsd(
  modelId: GeminiModelId,
  usage: ModelUsage,
): number {
  const price = PRICE_TABLE[modelId];
  const billableInputTokens = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const inputCost =
    (billableInputTokens / 1_000_000) * price.inputPerMillion(usage.inputTokens);
  const outputCost =
    (usage.outputTokens / 1_000_000) * price.outputPerMillion(usage.inputTokens);
  const cachedCost =
    (usage.cachedTokens / 1_000_000) * price.cachedPerMillion(usage.inputTokens);
  const groundingCost = usage.groundedPrompts * SEARCH_GROUNDING_COST_USD;
  return inputCost + outputCost + cachedCost + groundingCost;
}

export class GeminiProvider implements ModelProvider {
  private readonly ai: GoogleGenAI;
  private readonly cacheHandles = new Map<string, string>();

  constructor(
    readonly id: GeminiModelId,
    apiKey = config.geminiApiKey,
  ) {
    if (!apiKey) {
      throw new ModelProviderError("GEMINI_API_KEY is not set.");
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  private async resolveCache(opts: GenerateOptions): Promise<{
    messages: ModelMessage[];
    cachedContent?: string;
    cache?: ModelResult["cache"];
  }> {
    if (!opts.cacheKey || !opts.cacheMessages?.length) {
      return { messages: opts.messages };
    }

    const fallbackMessages = [...opts.cacheMessages, ...opts.messages];
    const estimatedTokens = estimateTokens(opts.cacheMessages);
    if (!config.explicitCache) {
      return {
        messages: fallbackMessages,
        cache: {
          key: opts.cacheKey,
          status: "skipped",
          reason: "explicit_cache_disabled",
        },
      };
    }
    if (estimatedTokens < CACHE_MIN_TOKENS[this.id]) {
      return {
        messages: fallbackMessages,
        cache: {
          key: opts.cacheKey,
          status: "skipped",
          reason: `below_minimum_${CACHE_MIN_TOKENS[this.id]}_tokens`,
        },
      };
    }

    const existing = this.cacheHandles.get(opts.cacheKey);
    if (existing) {
      return {
        messages: opts.messages,
        cachedContent: existing,
        cache: { key: opts.cacheKey, status: "hit" },
      };
    }

    try {
      const cache = await this.ai.caches.create({
        model: this.id,
        config: {
          contents: opts.cacheMessages.map(toGeminiContent),
          displayName: opts.cacheKey,
          ttl: `${opts.cacheTtlSeconds ?? 3600}s`,
        },
      });
      if (!cache.name) {
        return {
          messages: fallbackMessages,
          cache: {
            key: opts.cacheKey,
            status: "failed",
            reason: "cache_create_returned_no_name",
          },
        };
      }
      this.cacheHandles.set(opts.cacheKey, cache.name);
      return {
        messages: opts.messages,
        cachedContent: cache.name,
        cache: { key: opts.cacheKey, status: "created" },
      };
    } catch (err) {
      return {
        messages: fallbackMessages,
        cache: {
          key: opts.cacheKey,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async generate(opts: GenerateOptions): Promise<ModelResult> {
    assertSupportedCombination(opts);

    const started = Date.now();
    const cache = await this.resolveCache(opts);
    const request = {
      model: this.id,
      contents: cache.messages.map(toGeminiContent),
      config: buildConfig(opts, cache.cachedContent),
    };

    let response: GenerateContentResponse | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await this.ai.models.generateContent(request);
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(250 * attempt);
      }
    }

    if (!response) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new ModelProviderError(`Gemini model call failed: ${message}`, {
        modelId: this.id,
      });
    }

    const usage = usageFromResponse(response, opts.grounding ?? false);
    const costUsd = calculateGeminiCostUsd(this.id, usage);
    return {
      provider: "gemini",
      modelId: this.id,
      text: response.text ?? "",
      message: extractMessage(response),
      toolCalls: extractToolCalls(response),
      thinking: extractThinking(response),
      citations: extractCitations(response),
      usage,
      costUsd,
      latencyMs: Date.now() - started,
      cache: cache.cache,
    };
  }
}

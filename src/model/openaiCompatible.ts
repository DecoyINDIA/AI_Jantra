import type { GeminiModelId } from "../config.js";
import { config } from "../config.js";
import { ModelProviderError } from "../runtime/errors.js";
import { GeminiProvider } from "./gemini.js";
import type {
  GenerateOptions,
  ModelContentPart,
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ToolCall,
  ToolSpec,
} from "./provider.js";

/**
 * Provider for any OpenAI-compatible `/chat/completions` endpoint — OpenRouter
 * (default), OpenAI, DeepSeek, Groq, Together, local vLLM/Ollama, etc. Switch
 * models by changing the configured model id alone; no code changes needed.
 *
 * Grounded calls (Google Search) are Gemini-only, so any request with
 * `grounding: true` is delegated to an internal GeminiProvider. This is the
 * "hybrid" rule: the chosen model handles everything except grounded research.
 */

interface OpenAICompatibleOptions {
  /** The model id sent to the endpoint, e.g. "anthropic/claude-sonnet-4". */
  id: string;
  baseUrl: string;
  apiKey: string;
  /** Gemini model used when a call requests grounding. */
  groundingModelId: GeminiModelId;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

interface OpenAIToolCall {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 4xx other than 429 (rate limit) will not succeed on retry. */
function isNonRetryableStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return 250 * attempt;
}

function toOpenAIMessages(
  system: string | undefined,
  messages: ModelMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({
        role: message.role === "model" ? "assistant" : "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "model") {
      const texts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "functionCall") {
          toolCalls.push({
            id: part.id ?? `call_${toolCalls.length}`,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
          });
        }
        // "thought" parts are dropped: reasoning is not replayed to the model.
      }
      const text = texts.join("\n");
      out.push({
        role: "assistant",
        content: text || (toolCalls.length ? null : ""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // role === "user": may carry tool results (functionResponse) and/or text.
    const texts: string[] = [];
    for (const part of message.content) {
      if (part.type === "functionResponse") {
        out.push({
          role: "tool",
          tool_call_id: part.id ?? part.name,
          content: JSON.stringify(part.response ?? {}),
        });
      } else if (part.type === "text") {
        texts.push(part.text);
      }
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }

  return out;
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function extractToolCalls(response: OpenAIResponse): ToolCall[] {
  const calls = response.choices?.[0]?.message?.tool_calls ?? [];
  return calls
    .filter((call) => call.function?.name)
    .map((call) => {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = { _raw: call.function.arguments };
      }
      return { id: call.id, name: call.function.name, args };
    });
}

function buildMessage(text: string, toolCalls: ToolCall[]): ModelMessage {
  const parts: ModelContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const call of toolCalls) {
    parts.push({ type: "functionCall", id: call.id, name: call.name, args: call.args });
  }
  return parts.length ? { role: "model", content: parts } : { role: "model", content: "" };
}

function usageFromResponse(response: OpenAIResponse): ModelUsage {
  const usage = response.usage;
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: prompt,
    outputTokens: completion,
    cachedTokens: cached,
    thinkingTokens: reasoning,
    totalTokens: usage?.total_tokens ?? prompt + completion,
    groundedPrompts: 0,
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly groundingModelId: GeminiModelId;
  private readonly pricing: OpenAICompatibleOptions["pricing"];
  private grounder?: GeminiProvider;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.id) {
      throw new ModelProviderError(
        "No model configured for the OpenAI-compatible provider. Set JANTRA_MODEL.",
      );
    }
    if (!opts.apiKey) {
      throw new ModelProviderError("JANTRA_API_KEY is not set.");
    }
    this.id = opts.id;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.groundingModelId = opts.groundingModelId;
    this.pricing = opts.pricing;
  }

  /** Lazily build the Gemini provider used for grounded (web-search) calls. */
  private grounderProvider(): GeminiProvider {
    if (!this.grounder) {
      this.grounder = new GeminiProvider(this.groundingModelId);
    }
    return this.grounder;
  }

  private costUsd(usage: ModelUsage, reportedCost?: number): number {
    if (typeof reportedCost === "number" && Number.isFinite(reportedCost)) {
      return reportedCost;
    }
    const inputCost = (usage.inputTokens / 1_000_000) * this.pricing.inputPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * this.pricing.outputPerMillion;
    return inputCost + outputCost;
  }

  async generate(opts: GenerateOptions): Promise<ModelResult> {
    // Hybrid rule: grounded search is Gemini-only — delegate it.
    if (opts.grounding) {
      return this.grounderProvider().generate(opts);
    }

    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.id,
      messages: toOpenAIMessages(opts.system, opts.messages),
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxOutputTokens ?? config.maxOutputTokens,
      // OpenRouter returns real per-call cost in usage when accounting is on.
      usage: { include: true },
    };

    // Optional data-governance policy (OpenRouter). When configured, restrict
    // routing to providers honoring the policy — "deny" excludes providers that
    // store or train on inputs. Omitted by default; other OpenAI-compatible
    // endpoints simply ignore the unknown field.
    if (config.dataCollection) {
      body.provider = { data_collection: config.dataCollection };
    }

    if (opts.tools?.length) {
      body.tools = toOpenAITools(opts.tools);
      body.tool_choice =
        opts.toolChoice === "required"
          ? "required"
          : opts.toolChoice === "none"
            ? "none"
            : "auto";
    }

    if (opts.responseJsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: opts.responseJsonSchema },
      };
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Title": "Jantra",
    };

    let data: OpenAIResponse | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
          // Non-retryable client errors (400/401/403/404/422) will never succeed
          // on retry — fail fast instead of burning the retry budget.
          if (isNonRetryableStatus(response.status)) throw error;
          lastError = error;
          if (attempt < 3) await sleep(retryDelayMs(response, attempt));
          continue;
        }
        data = (await response.json()) as OpenAIResponse;
        break;
      } catch (err) {
        // A thrown non-retryable error above must propagate immediately.
        if (err instanceof Error && /^HTTP 4(0[0134]|22):/.test(err.message)) {
          throw new ModelProviderError(`OpenAI-compatible model call failed: ${err.message}`, {
            modelId: this.id,
            baseUrl: this.baseUrl,
          });
        }
        lastError = err;
        if (attempt < 3) await sleep(250 * attempt);
      }
    }

    if (!data) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new ModelProviderError(`OpenAI-compatible model call failed: ${message}`, {
        modelId: this.id,
        baseUrl: this.baseUrl,
      });
    }

    const choice = data.choices?.[0]?.message;
    const text = choice?.content ?? "";
    const thinking = (choice?.reasoning ?? choice?.reasoning_content ?? undefined) || undefined;
    const toolCalls = extractToolCalls(data);
    const usage = usageFromResponse(data);

    return {
      provider: "openai-compatible",
      modelId: this.id,
      text,
      message: buildMessage(text, toolCalls),
      toolCalls,
      thinking,
      citations: [],
      usage,
      costUsd: this.costUsd(usage, data.usage?.cost),
      latencyMs: Date.now() - started,
      cache: opts.cacheKey
        ? { key: opts.cacheKey, status: "skipped", reason: "openai_compatible_no_explicit_cache" }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    await this.grounder?.dispose();
  }
}

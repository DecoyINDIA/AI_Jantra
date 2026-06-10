export type ModelRole = "user" | "model";

export type ModelContentPart =
  | {
      type: "text" | "thought";
      text: string;
      thoughtSignature?: string;
    }
  | {
      type: "functionCall";
      id?: string;
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "functionResponse";
      id?: string;
      name: string;
      response: Record<string, unknown>;
    };

export interface ModelMessage {
  role: ModelRole;
  content: string | ModelContentPart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GroundingCitation {
  uri: string;
  title: string;
  segmentText?: string;
  confidence?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  groundedPrompts: number;
}

export interface GenerateOptions {
  purpose?: string;
  system?: string;
  cacheKey?: string;
  cacheSystem?: string;
  cacheMessages?: ModelMessage[];
  cacheFallbackMessages?: boolean;
  cacheTtlSeconds?: number;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "required" | "none";
  allowedToolNames?: string[];
  responseJsonSchema?: unknown;
  grounding?: boolean;
  thinking?: boolean;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ModelResult {
  provider: "gemini" | "mock" | "openai-compatible";
  modelId: string;
  text: string;
  message: ModelMessage;
  toolCalls: ToolCall[];
  thinking?: string;
  citations: GroundingCitation[];
  usage: ModelUsage;
  costUsd: number;
  latencyMs: number;
  cache?: {
    key: string;
    status: "created" | "hit" | "skipped" | "failed";
    reason?: string;
  };
}

export interface ModelProvider {
  readonly id: string;
  generate(opts: GenerateOptions): Promise<ModelResult>;
  dispose?(): Promise<void>;
}

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { AuditLogger } from "./audit.js";
import { consoleHandoff } from "./handoff.js";
import { RuleBasedPolicy } from "./policy.js";
import type {
  AgentSpec,
  AnyTool,
  ApprovalHandler,
  HandoffHandler,
  Policy,
  RunResult,
  ToolContext,
} from "./types.js";

export interface AgentOptions {
  spec: AgentSpec;
  client?: Anthropic;
  policy?: Policy;
  /** Called when a gated action needs sign-off. Default denies (fail closed). */
  onApproval?: ApprovalHandler;
  /** Called when the agent hands off to a human. */
  onHandoff?: HandoffHandler;
}

/**
 * The Mainframe runtime. A manual agentic loop — chosen over the SDK's tool
 * runner precisely because every action must pass the policy gate, be logged
 * with its reasoning, and be interruptible for human approval or handoff.
 *
 * The same runtime drives any vertical; only the AgentSpec (prompt + tools)
 * changes. That is the studio thesis: one engine, many agents.
 */
export class Agent {
  private readonly client: Anthropic;
  private readonly policy: Policy;
  private readonly onApproval: ApprovalHandler;
  private readonly onHandoff: HandoffHandler;
  private readonly toolsByName: Map<string, AnyTool>;
  private readonly anthropicTools: Anthropic.Tool[];

  constructor(private readonly opts: AgentOptions) {
    this.client = opts.client ?? new Anthropic();
    this.policy = opts.policy ?? new RuleBasedPolicy();
    this.onApproval = opts.onApproval ?? (async () => false);
    this.onHandoff = opts.onHandoff ?? consoleHandoff;

    this.toolsByName = new Map(opts.spec.tools.map((t) => [t.name, t]));
    // Stable order — never sort at request time, or the prompt cache breaks.
    this.anthropicTools = opts.spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  async run(userMessage: string): Promise<RunResult> {
    const runId = randomUUID();
    const audit = new AuditLogger(runId, config.auditDir);

    let handoff: { reason: string; summary: string } | null = null;
    const ctx: ToolContext = {
      runId,
      audit,
      requestHandoff: (reason, summary) => {
        handoff = { reason, summary };
      },
    };

    audit.record("run_start", {
      agent: this.opts.spec.name,
      model: config.model,
      effort: config.effort,
      userMessage,
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
    ];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    let finalText: string | null = null;
    let steps = 0;

    while (steps < config.maxSteps) {
      steps++;

      // Tools render first, then system. cache_control on the last system block
      // caches tools + system together; the prompt is byte-stable across turns.
      const response = await this.client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: config.effort },
        system: [
          {
            type: "text",
            text: this.opts.spec.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: this.anthropicTools,
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming);

      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
      audit.record("model_usage", { step: steps, usage: response.usage });

      // Log the agent's reasoning and any prose — the "why" behind every action.
      for (const block of response.content) {
        if (block.type === "thinking" && block.thinking) {
          audit.record("agent_thinking", { step: steps, text: block.thinking });
        } else if (block.type === "text") {
          audit.record("agent_message", { step: steps, text: block.text });
        }
      }

      // Preserve the full assistant turn (incl. thinking + tool_use blocks).
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        ctx.requestHandoff(
          "model_refusal",
          "The model declined to act on this request. A person should review it.",
        );
        break;
      }

      if (response.stop_reason === "end_turn") {
        finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      if (response.stop_reason !== "tool_use") {
        // pause_turn or anything unexpected: re-send to let the server resume.
        continue;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        toolResults.push(await this.handleToolCall(call, ctx));
        if (handoff) break; // an escalate tool fired — stop dispatching more
      }
      messages.push({ role: "user", content: toolResults });

      if (handoff) break;
    }

    if (handoff) {
      const h = handoff as { reason: string; summary: string };
      audit.record("handoff", h);
      await this.onHandoff({ runId, ...h });
    }

    audit.record("run_end", {
      handedOff: handoff !== null,
      steps,
      usage,
      finalText,
    });

    return {
      runId,
      finalText,
      handedOff: handoff !== null,
      steps,
      usage,
    };
  }

  private async handleToolCall(
    call: Anthropic.ToolUseBlock,
    ctx: ToolContext,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      ctx.audit.record("error", { toolName: call.name, error: "unknown_tool" });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        is_error: true,
        content: `Unknown tool: ${call.name}`,
      };
    }

    ctx.audit.record("tool_call", {
      toolName: tool.name,
      risk: tool.risk,
      input: call.input,
    });

    // 1. Guardrail gate.
    const verdict = this.policy.decide(tool, call.input);
    ctx.audit.record("policy_decision", {
      toolName: tool.name,
      decision: verdict.decision,
      reason: verdict.reason,
    });

    if (verdict.decision === "deny") {
      return {
        type: "tool_result",
        tool_use_id: call.id,
        is_error: true,
        content: `Action blocked by policy: ${verdict.reason} Do not retry; hand off if needed.`,
      };
    }

    // 2. Human-in-the-loop for gated actions.
    if (verdict.decision === "ask") {
      const approved = await this.onApproval({
        runId: ctx.runId,
        toolName: tool.name,
        input: call.input,
        reason: verdict.reason,
      });
      ctx.audit.record("approval", { toolName: tool.name, approved });
      if (!approved) {
        return {
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `A human declined this action. Do not retry it. Consider an alternative or hand off.`,
        };
      }
    }

    // 3. Execute.
    try {
      const result = await tool.run(call.input as Record<string, unknown>, ctx);
      ctx.audit.record("tool_result", {
        toolName: tool.name,
        isError: result.isError ?? false,
        content: result.content,
      });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        is_error: result.isError ?? false,
        content: result.content,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit.record("error", { toolName: tool.name, error: message });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        is_error: true,
        content: `Tool "${tool.name}" failed: ${message}`,
      };
    }
  }
}

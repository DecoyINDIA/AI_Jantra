import { randomUUID } from "node:crypto";

import { AuditLogger } from "./audit.js";
import { config } from "./config.js";
import { consoleHandoff } from "./handoff.js";
import { createProviderForStage } from "./model/index.js";
import type { ModelContentPart, ModelMessage, ModelProvider, ToolCall } from "./model/provider.js";
import { RuleBasedPolicy } from "./policy.js";
import { recordModelCall } from "./runtime/telemetry.js";
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
  provider?: ModelProvider;
  policy?: Policy;
  onApproval?: ApprovalHandler;
  onHandoff?: HandoffHandler;
}

/**
 * The Jantra AI runtime. It keeps tool execution outside the SDK runner because
 * every action must pass policy, approval, audit, and handoff checks first.
 */
export class Agent {
  private readonly provider: ModelProvider;
  private readonly policy: Policy;
  private readonly onApproval: ApprovalHandler;
  private readonly onHandoff: HandoffHandler;
  private readonly toolsByName: Map<string, AnyTool>;

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider ?? createProviderForStage("intake");
    this.policy = opts.policy ?? new RuleBasedPolicy();
    this.onApproval = opts.onApproval ?? (async () => false);
    this.onHandoff = opts.onHandoff ?? consoleHandoff;
    this.toolsByName = new Map(opts.spec.tools.map((t) => [t.name, t]));
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
      provider: this.provider.id,
      userMessage,
    });

    const messages: ModelMessage[] = [{ role: "user", content: userMessage }];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thinkingTokens: 0,
      costUsd: 0,
    };

    let finalText: string | null = null;
    let steps = 0;

    while (steps < config.maxSteps) {
      steps++;
      const result = await this.provider.generate({
        purpose: "agent_turn",
        system: this.opts.spec.systemPrompt,
        messages,
        tools: this.opts.spec.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        thinking: true,
        maxOutputTokens: config.maxOutputTokens,
      });
      recordModelCall(audit, null, null, "agent_turn", result);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cachedTokens += result.usage.cachedTokens;
      usage.thinkingTokens += result.usage.thinkingTokens;
      usage.costUsd += result.costUsd;

      if (result.text) {
        audit.record("agent_message", { step: steps, text: result.text });
      }
      messages.push(result.message);

      if (!result.toolCalls.length) {
        finalText = result.text.trim() || null;
        break;
      }

      const toolResults: ModelContentPart[] = [];
      for (const call of result.toolCalls) {
        toolResults.push(await this.handleToolCall(call, ctx));
        if (handoff) break;
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
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<ModelContentPart> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      ctx.audit.record("error", { toolName: call.name, error: "unknown_tool" });
      return {
        type: "functionResponse",
        id: call.id,
        name: call.name,
        response: { error: `Unknown tool: ${call.name}` },
      };
    }

    ctx.audit.record("tool_call", {
      toolName: tool.name,
      risk: tool.risk,
      input: call.args,
    });

    const verdict = this.policy.decide(tool, call.args);
    ctx.audit.record("policy_decision", {
      toolName: tool.name,
      decision: verdict.decision,
      reason: verdict.reason,
    });

    if (verdict.decision === "deny") {
      return {
        type: "functionResponse",
        id: call.id,
        name: call.name,
        response: {
          error: `Action blocked by policy: ${verdict.reason} Do not retry; hand off if needed.`,
        },
      };
    }

    if (verdict.decision === "ask") {
      const approved = await this.onApproval({
        runId: ctx.runId,
        toolName: tool.name,
        input: call.args,
        reason: verdict.reason,
      });
      ctx.audit.record("approval", { toolName: tool.name, approved });
      if (!approved) {
        return {
          type: "functionResponse",
          id: call.id,
          name: call.name,
          response: {
            error: "A human declined this action. Do not retry it.",
          },
        };
      }
    }

    try {
      const result = await tool.run(call.args, ctx);
      ctx.audit.record("tool_result", {
        toolName: tool.name,
        isError: result.isError ?? false,
        content: result.content,
      });
      return {
        type: "functionResponse",
        id: call.id,
        name: call.name,
        response: result.isError
          ? { error: result.content }
          : { output: result.content },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit.record("error", { toolName: tool.name, error: message });
      return {
        type: "functionResponse",
        id: call.id,
        name: call.name,
        response: { error: `Tool "${tool.name}" failed: ${message}` },
      };
    }
  }
}

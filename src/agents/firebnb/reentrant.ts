import { createHash } from "node:crypto";

import { redactToolInput } from "../../audit.js";
import { config } from "../../config.js";
import type {
  ModelContentPart,
  ModelMessage,
  ToolCall,
} from "../../model/provider.js";
import { RuleBasedPolicy } from "../../policy.js";
import { StageFailedClosedError } from "../../runtime/errors.js";
import {
  createApprovalInteraction,
  createQuestionInteraction,
  pendingInteraction,
  upsertPendingInteraction,
} from "../../runtime/interactions.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import {
  createStageExecutionState,
  loadStageExecutionState,
  saveStageExecutionState,
} from "../../pipeline/executionState.js";
import type { StageRunStep } from "../../pipeline/reentrant.js";
import type {
  InteractionResponse,
  PersistedStageState,
  StageContext,
} from "../../pipeline/types.js";
import type { AnyTool, Policy, ToolContext } from "../../types.js";
import { firebnbConciergeSpec } from "./index.js";

type ConciergePhase = "awaiting_request" | "model_turn" | "awaiting_approval" | "complete";

interface ConciergeStateData {
  phase: ConciergePhase;
  finalText?: string | null;
  handedOff?: boolean;
  pendingToolCall?: ToolCall;
  pendingToolResults?: ModelContentPart[];
  remainingToolCalls?: ToolCall[];
}

const toolsByName = new Map<string, AnyTool>(
  firebnbConciergeSpec.tools.map((tool) => [tool.name, tool]),
);

function conciergeCacheKey(): string {
  const hash = createHash("sha256")
    .update(firebnbConciergeSpec.systemPrompt)
    .digest("hex")
    .slice(0, 16);
  return `agent:${firebnbConciergeSpec.name}:system:${hash}`;
}

function conciergeData(state: PersistedStageState): ConciergeStateData {
  return {
    phase: typeof state.data.phase === "string" ? (state.data.phase as ConciergePhase) : "awaiting_request",
    finalText: typeof state.data.finalText === "string" ? state.data.finalText : null,
    handedOff: state.data.handedOff === true,
    pendingToolCall:
      state.data.pendingToolCall && typeof state.data.pendingToolCall === "object"
        ? (state.data.pendingToolCall as ToolCall)
        : undefined,
    pendingToolResults: Array.isArray(state.data.pendingToolResults)
      ? (state.data.pendingToolResults as ModelContentPart[])
      : undefined,
    remainingToolCalls: Array.isArray(state.data.remainingToolCalls)
      ? (state.data.remainingToolCalls as ToolCall[])
      : undefined,
  };
}

function setConciergeData(state: PersistedStageState, data: ConciergeStateData): void {
  state.data = { ...state.data, ...data };
}

function createConciergeState(ctx: StageContext): PersistedStageState {
  const state = createStageExecutionState(ctx.stageId, ctx.stageDefinition.runnerKind, {
    phase: "awaiting_request",
  });
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return state;
}

function responsePart(call: ToolCall, response: Record<string, unknown>): ModelContentPart {
  return {
    type: "functionResponse",
    id: call.id,
    name: call.name,
    response,
  };
}

function awaitingQuestion(
  ctx: StageContext,
  state: PersistedStageState,
  prompt: string,
): StageRunStep {
  const existing = pendingInteraction(ctx.project, state.pendingInteractionId);
  const interaction =
    existing ?? upsertPendingInteraction(ctx.project, createQuestionInteraction(ctx.project, ctx.stageId, prompt));
  state.pendingInteractionId = interaction.id;
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return { status: "awaiting_input", state, interaction };
}

function awaitingApproval(
  ctx: StageContext,
  state: PersistedStageState,
  call: ToolCall,
  reason: string,
  toolResults: ModelContentPart[],
  remainingToolCalls: ToolCall[],
): StageRunStep {
  const prompt = `Approve ${call.name}? ${reason}`;
  const existing = pendingInteraction(ctx.project, state.pendingInteractionId);
  const interaction =
    existing ??
    upsertPendingInteraction(
      ctx.project,
      createApprovalInteraction(ctx.project, ctx.stageId, prompt, call.name, call.args),
    );
  setConciergeData(state, {
    ...conciergeData(state),
    phase: "awaiting_approval",
    pendingToolCall: call,
    pendingToolResults: toolResults,
    remainingToolCalls,
  });
  state.pendingInteractionId = interaction.id;
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return { status: "awaiting_input", state, interaction };
}

function completeConcierge(ctx: StageContext, state: PersistedStageState): StageRunStep {
  const data = conciergeData(state);
  setConciergeData(state, { ...data, phase: "complete" });
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return {
    status: "awaiting_confirmation",
    state,
    artifacts: [
      {
        stage: ctx.stageId,
        kind: "conversation_summary",
        title: "Concierge conversation summary",
        content: `# Concierge Conversation Summary

Final reply:
${data.finalText ?? "(none)"}

Steps: ${state.step}
`,
        version: 1,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

async function executeAllowedTool(
  ctx: StageContext,
  state: PersistedStageState,
  call: ToolCall,
): Promise<ModelContentPart> {
  const tool = toolsByName.get(call.name);
  if (!tool) {
    ctx.audit.record("error", { toolName: call.name, error: "unknown_tool" });
    return responsePart(call, { error: `Unknown tool: ${call.name}` });
  }

  let handoff: { reason: string; summary: string } | null = null;
  const toolCtx: ToolContext = {
    runId: ctx.project.id,
    audit: ctx.audit,
    requestHandoff: (reason, summary) => {
      handoff = { reason, summary };
    },
  };

  try {
    const result = await tool.run(call.args, toolCtx);
    ctx.audit.record("tool_result", {
      toolName: tool.name,
      isError: result.isError ?? false,
      content: result.content,
    });

    if (call.name === "finish_conversation" && !result.isError) {
      setConciergeData(state, {
        ...conciergeData(state),
        phase: "complete",
        finalText: "The user has completed the concierge search.",
      });
    }

    if (handoff) {
      const h = handoff as { reason: string; summary: string };
      ctx.audit.record("handoff", h);
      setConciergeData(state, {
        ...conciergeData(state),
        handedOff: true,
        finalText: `Handed off: ${h.reason}\n\n${h.summary}`,
        phase: "complete",
      });
    }

    return responsePart(
      call,
      result.isError ? { error: result.content } : { output: result.content },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.audit.record("error", { toolName: tool.name, error: message });
    return responsePart(call, { error: `Tool "${tool.name}" failed: ${message}` });
  }
}

async function processToolCalls(
  ctx: StageContext,
  state: PersistedStageState,
  policy: Policy,
  calls: ToolCall[],
  initialToolResults: ModelContentPart[] = [],
): Promise<StageRunStep | null> {
  const toolResults = [...initialToolResults];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const tool = toolsByName.get(call.name);
    if (!tool) {
      toolResults.push(responsePart(call, { error: `Unknown tool: ${call.name}` }));
      continue;
    }

    ctx.audit.record("tool_call", {
      toolName: tool.name,
      risk: tool.risk,
      input: redactToolInput(call.args),
    });
    const verdict = policy.decide(tool, call.args);
    ctx.audit.record("policy_decision", {
      toolName: tool.name,
      decision: verdict.decision,
      reason: verdict.reason,
    });

    if (verdict.decision === "deny") {
      toolResults.push(
        responsePart(call, {
          error: `Action blocked by policy: ${verdict.reason} Do not retry; hand off if needed.`,
        }),
      );
      continue;
    }

    if (verdict.decision === "ask") {
      return awaitingApproval(
        ctx,
        state,
        call,
        verdict.reason,
        toolResults,
        calls.slice(index + 1),
      );
    }

    toolResults.push(await executeAllowedTool(ctx, state, call));
    if (conciergeData(state).phase === "complete" || conciergeData(state).handedOff) {
      for (const skipped of calls.slice(index + 1)) {
        ctx.audit.record("tool_call", {
          toolName: skipped.name,
          skipped: true,
          reason: "concierge_flow_ended",
        });
      }
      break;
    }
  }

  state.messages.push({ role: "user", content: toolResults });
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  if (conciergeData(state).phase === "complete" || conciergeData(state).handedOff) {
    return completeConcierge(ctx, state);
  }
  return null;
}

async function continueConcierge(
  ctx: StageContext,
  state: PersistedStageState,
  policy: Policy,
): Promise<StageRunStep> {
  while (state.step < config.maxSteps) {
    state.step++;
    const result = await ctx.provider.generate({
      purpose: `agent_turn_${state.step}`,
      system: firebnbConciergeSpec.systemPrompt,
      messages: state.messages,
      tools: firebnbConciergeSpec.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      thinking: true,
      thinkingBudget: firebnbConciergeSpec.thinkingBudget ?? config.thinkingBudget,
      cacheKey: conciergeCacheKey(),
      cacheSystem: firebnbConciergeSpec.systemPrompt,
      cacheFallbackMessages: false,
      maxOutputTokens: firebnbConciergeSpec.maxOutputTokens ?? config.maxOutputTokens,
    });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "agent_turn", result);
    if (result.text) {
      ctx.audit.record("agent_message", { step: state.step, text: result.text });
    }
    state.messages.push(result.message);

    // If the tool execution finished the conversation, complete
    const currentData = conciergeData(state);
    if (currentData.phase === "complete") {
      setConciergeData(state, {
        ...currentData,
        finalText: result.text.trim() || null,
      });
      return completeConcierge(ctx, state);
    }

    if (!result.toolCalls.length) {
      // Concierge loop behavior: instead of completing on text response,
      // return it as the next awaiting_input question prompt to keep chat going.
      setConciergeData(state, {
        ...currentData,
        phase: "awaiting_request",
      });
      return awaitingQuestion(ctx, state, result.text.trim());
    }

    const pending = await processToolCalls(ctx, state, policy, result.toolCalls);
    if (pending) return pending;
  }

  throw new StageFailedClosedError("Concierge agent hit the step cap without completion.", {
    projectId: ctx.project.id,
    clientId: ctx.project.clientId,
  });
}

async function resumeApproval(
  ctx: StageContext,
  state: PersistedStageState,
  policy: Policy,
  response: InteractionResponse,
): Promise<StageRunStep> {
  const data = conciergeData(state);
  const call = data.pendingToolCall;
  if (!call) {
    throw new StageFailedClosedError("Concierge approval state did not include a tool call.");
  }
  state.pendingInteractionId = undefined;
  const toolResults = [...(data.pendingToolResults ?? [])];
  if (response.approved) {
    ctx.audit.record("approval", { toolName: call.name, approved: true });
    toolResults.push(await executeAllowedTool(ctx, state, call));
  } else {
    ctx.audit.record("approval", { toolName: call.name, approved: false });
    toolResults.push(responsePart(call, { error: "A human declined this action. Do not retry it." }));
  }
  setConciergeData(state, {
    ...data,
    phase: "model_turn",
    pendingToolCall: undefined,
    pendingToolResults: undefined,
    remainingToolCalls: undefined,
  });
  const pending = await processToolCalls(
    ctx,
    state,
    policy,
    data.remainingToolCalls ?? [],
    toolResults,
  );
  if (pending) return pending;
  return continueConcierge(ctx, state, policy);
}

export function createConciergeReentrant(policy: Policy = new RuleBasedPolicy()) {
  return {
    async start(ctx: StageContext): Promise<StageRunStep> {
      const state = loadStageExecutionState(ctx.project, ctx.stageId) ?? createConciergeState(ctx);
      const pending = pendingInteraction(ctx.project, state.pendingInteractionId);
      if (pending) return { status: "awaiting_input", state, interaction: pending };
      if (!state.messages.length) {
        setConciergeData(state, { phase: "awaiting_request" });
        return awaitingQuestion(ctx, state, "Hello! I am your FireBNB travel concierge. How can I help you find the best hotel deals today?");
      }
      return continueConcierge(ctx, state, policy);
    },

    async resume(ctx: StageContext, response: InteractionResponse): Promise<StageRunStep> {
      const state = loadStageExecutionState(ctx.project, ctx.stageId) ?? createConciergeState(ctx);
      if (state.pendingInteractionId !== response.interactionId) {
        throw new StageFailedClosedError("Interaction does not match the pending Concierge state.", {
          expected: state.pendingInteractionId,
          received: response.interactionId,
        });
      }
      const data = conciergeData(state);
      if (data.phase === "awaiting_approval") {
        return resumeApproval(ctx, state, policy, response);
      }

      const request = response.text?.trim();
      if (!request) {
        throw new StageFailedClosedError("Concierge request response was empty.", {
          interactionId: response.interactionId,
        });
      }
      state.pendingInteractionId = undefined;
      state.messages.push({ role: "user", content: request } satisfies ModelMessage);
      setConciergeData(state, { phase: "model_turn" });
      saveStageExecutionState(ctx.project, ctx.stageId, state);
      return continueConcierge(ctx, state, policy);
    },
  };
}

export const runFirebnbConciergeReentrant = createConciergeReentrant();

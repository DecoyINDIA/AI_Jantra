import { z } from "zod";

import { config } from "../../config.js";
import type { ModelMessage, ToolSpec } from "../../model/provider.js";
import { makeEvalScore } from "../../runtime/evaluator.js";
import { SchemaValidationError, StageFailedClosedError } from "../../runtime/errors.js";
import {
  createQuestionInteraction,
  pendingInteraction,
  upsertPendingInteraction,
} from "../../runtime/interactions.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import {
  createStageExecutionState,
  loadStageExecutionState,
  saveStageExecutionState,
} from "../executionState.js";
import type { StageRunStep } from "../reentrant.js";
import type {
  Artifact,
  EvalScore,
  InteractionResponse,
  PersistedStageState,
  StageContext,
} from "../types.js";

const SYSTEM_PROMPT = `You are the intake specialist at Xolver, a studio that turns ideas into built products.

Your job: understand a client's product idea well enough that a research team and a planning team can take it forward. You are the first human-feeling touchpoint, so be warm, sharp, and brief.

How to work:
- Ask focused clarifying questions, one or two at a time. Never dump a long list.
- Cover what matters: the real problem, who has it, the proposed solution, the must-have features, constraints (budget, timeline, tech, platform), and how success is judged.
- Do not pad. If the client already answered something, do not re-ask it.
- When you genuinely understand the idea, call submit_idea_summary with a clear, structured summary. Do not call it before you have enough to research and plan.

Tone: plain, concrete, friendly. Short sentences. No em dashes. No filler.`;

const ideaSummarySchema = z.object({
  title: z.string().min(3),
  problem: z.string().min(10),
  solution: z.string().min(10),
  targetUsers: z.string().min(5),
  keyFeatures: z.array(z.string().min(3)).min(1),
  constraints: z.string().min(3),
  successCriteria: z.string().min(5),
  openQuestions: z.array(z.string()).default([]),
});

type IdeaSummary = z.infer<typeof ideaSummarySchema>;

const intakeCritiqueSchema = z.object({
  scores: z.object({
    specificity: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
    researchability: z.number().min(1).max(5),
    noInventedDetails: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
  followUpQuestions: z.array(z.string()).default([]),
});

const submitTool: ToolSpec = {
  name: "submit_idea_summary",
  description:
    "Submit the final structured summary of the client's idea. Only call this once you understand the idea well enough for a team to research and plan it.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short name for the product or idea." },
      problem: { type: "string", description: "The real problem being solved." },
      solution: { type: "string", description: "The proposed solution in plain terms." },
      targetUsers: { type: "string", description: "Who this is for." },
      keyFeatures: {
        type: "array",
        items: { type: "string" },
        description: "The must-have features.",
      },
      constraints: {
        type: "string",
        description: "Budget, timeline, tech, platform, or other constraints.",
      },
      successCriteria: { type: "string", description: "How success will be judged." },
      openQuestions: {
        type: "array",
        items: { type: "string" },
        description: "Things still unresolved that research or planning should settle.",
      },
    },
    required: [
      "title",
      "problem",
      "solution",
      "targetUsers",
      "keyFeatures",
      "constraints",
      "successCriteria",
      "openQuestions",
    ],
    additionalProperties: false,
  },
};

function renderSummary(s: IdeaSummary): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none noted)";
  return `# Idea summary - ${s.title}

## Problem
${s.problem}

## Solution
${s.solution}

## Target users
${s.targetUsers}

## Key features
${list(s.keyFeatures)}

## Constraints
${s.constraints}

## Success criteria
${s.successCriteria}

## Open questions
${list(s.openQuestions)}
`;
}

async function critiqueSummary(
  ctx: StageContext,
  summary: IdeaSummary,
): Promise<{ eval: EvalScore; followUpQuestions: string[] }> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system:
      "You are the Intake critic. Score whether the idea summary is specific, complete, researchable, and free of invented details. Return only JSON.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(summary, null, 2),
      },
    ],
    responseJsonSchema: z.toJSONSchema(intakeCritiqueSchema),
    thinking: true,
    maxOutputTokens: 2000,
    temperature: 0,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  const parsed = intakeCritiqueSchema.safeParse(JSON.parse(result.text));
  if (!parsed.success) {
    throw new SchemaValidationError("Intake critique failed schema validation.", {
      issues: parsed.error.issues,
    });
  }
  const evalScore = makeEvalScore(
    {
      id: "intake",
      passingScore: 4,
      criteria: ["specificity", "completeness", "researchability", "noInventedDetails"],
    },
    parsed.data.scores,
    parsed.data.notes,
  );
  evalScore.passed = evalScore.passed && parsed.data.passed;
  return { eval: evalScore, followUpQuestions: parsed.data.followUpQuestions };
}

export async function runIntake(ctx: StageContext): Promise<Artifact[]> {
  const { provider, audit, io, project } = ctx;

  io.say(
    "Hi, I'm the Xolver intake assistant. Tell me about the idea you want to build, in your own words.",
  );
  const firstIdea = await io.ask("your idea");

  const messages: ModelMessage[] = [{ role: "user", content: firstIdea }];

  for (let step = 0; step < config.maxSteps; step++) {
      const result = await provider.generate({
        purpose: "generator",
        system: SYSTEM_PROMPT,
      messages,
      tools: [submitTool],
      thinking: true,
      maxOutputTokens: config.maxOutputTokens,
    });
    trackStageModelCall(audit, project, ctx.stageId, "generator", result);
    messages.push(result.message);

    const submit = result.toolCalls.find((call) => call.name === "submit_idea_summary");
    if (submit) {
      const parsed = ideaSummarySchema.safeParse(submit.args);
      if (!parsed.success) {
        throw new SchemaValidationError("Idea summary failed schema validation.", {
          issues: parsed.error.issues,
        });
      }

      const critique = await critiqueSummary(ctx, parsed.data);
      project.stages[ctx.stageId]?.evals.push(critique.eval);
      audit.record("eval_score", {
        clientId: project.clientId,
        projectId: project.id,
        stage: ctx.stageId,
        rubric: critique.eval.rubric,
        scores: critique.eval.scores,
        passed: critique.eval.passed,
        notes: critique.eval.notes,
      });

      if (!critique.eval.passed && critique.followUpQuestions.length && step + 1 < config.maxSteps) {
        const questions = critique.followUpQuestions.slice(0, 2);
        io.say("\nI need to tighten a couple of details before I can hand this forward.");
        const answers: string[] = [];
        for (const question of questions) {
          answers.push(`${question}\n${await io.ask(question)}`);
        }
        messages.push({
          role: "user",
          content: `Critic follow-up answers:\n${answers.join("\n\n")}`,
        });
        continue;
      }

      if (!critique.eval.passed) {
        throw new StageFailedClosedError("Intake summary did not pass its rubric.", {
          projectId: project.id,
          clientId: project.clientId,
          eval: critique.eval,
        });
      }

      const content = renderSummary(parsed.data);
      audit.record("agent_message", {
        clientId: project.clientId,
        projectId: project.id,
        stage: ctx.stageId,
        step,
        summary: parsed.data,
      });
      io.say("\nThanks, that's everything I need. I've written up a summary.");
      project.title = parsed.data.title;
      return [
        {
          stage: ctx.stageId,
          kind: "idea_summary",
          title: parsed.data.title,
          content,
          version: 1,
          createdAt: new Date().toISOString(),
          eval: critique.eval,
        },
      ];
    }

    const question = result.text.trim();
    if (!question) {
      throw new StageFailedClosedError("Intake model produced no question and no summary.");
    }
    io.say("\n" + question);
    const answer = await io.ask("you");
    messages.push({ role: "user", content: answer });
  }

  throw new StageFailedClosedError("Intake hit the step cap without a valid summary.", {
    projectId: project.id,
    clientId: project.clientId,
  });
}

type IntakePhase =
  | "awaiting_initial_idea"
  | "awaiting_answer"
  | "awaiting_followup_answer"
  | "model_turn"
  | "complete";

interface IntakeStateData {
  phase: IntakePhase;
  followUpQuestions?: string[];
}

function intakeData(state: PersistedStageState): IntakeStateData {
  const phase =
    typeof state.data.phase === "string" ? state.data.phase : "awaiting_initial_idea";
  return {
    phase: phase as IntakePhase,
    followUpQuestions: Array.isArray(state.data.followUpQuestions)
      ? state.data.followUpQuestions.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

function setIntakeData(state: PersistedStageState, data: IntakeStateData): void {
  state.data = { ...state.data, ...data };
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

function createIntakeState(ctx: StageContext): PersistedStageState {
  const state = createStageExecutionState(ctx.stageId, ctx.stageDefinition.runnerKind, {
    phase: "awaiting_initial_idea",
  });
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return state;
}

async function continueIntake(
  ctx: StageContext,
  state: PersistedStageState,
): Promise<StageRunStep> {
  while (state.step < config.maxSteps) {
    const step = state.step;
    state.step++;
    const result = await ctx.provider.generate({
      purpose: "generator",
      system: SYSTEM_PROMPT,
      messages: state.messages,
      tools: [submitTool],
      thinking: true,
      maxOutputTokens: config.maxOutputTokens,
    });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);
    state.messages.push(result.message);

    const submit = result.toolCalls.find((call) => call.name === "submit_idea_summary");
    if (submit) {
      const parsed = ideaSummarySchema.safeParse(submit.args);
      if (!parsed.success) {
        throw new SchemaValidationError("Idea summary failed schema validation.", {
          issues: parsed.error.issues,
        });
      }

      const critique = await critiqueSummary(ctx, parsed.data);
      ctx.project.stages[ctx.stageId]?.evals.push(critique.eval);
      ctx.audit.record("eval_score", {
        clientId: ctx.project.clientId,
        projectId: ctx.project.id,
        stage: ctx.stageId,
        rubric: critique.eval.rubric,
        scores: critique.eval.scores,
        passed: critique.eval.passed,
        notes: critique.eval.notes,
      });

      if (!critique.eval.passed && critique.followUpQuestions.length && state.step < config.maxSteps) {
        const questions = critique.followUpQuestions.slice(0, 2);
        setIntakeData(state, {
          phase: "awaiting_followup_answer",
          followUpQuestions: questions,
        });
        return awaitingQuestion(
          ctx,
          state,
          `I need to tighten a couple of details before I can hand this forward.\n\n${questions.join(
            "\n",
          )}`,
        );
      }

      if (!critique.eval.passed) {
        throw new StageFailedClosedError("Intake summary did not pass its rubric.", {
          projectId: ctx.project.id,
          clientId: ctx.project.clientId,
          eval: critique.eval,
        });
      }

      const content = renderSummary(parsed.data);
      ctx.project.title = parsed.data.title;
      setIntakeData(state, { phase: "complete" });
      saveStageExecutionState(ctx.project, ctx.stageId, state);
      return {
        status: "awaiting_confirmation",
        state,
        artifacts: [
          {
            stage: ctx.stageId,
            kind: "idea_summary",
            title: parsed.data.title,
            content,
            version: 1,
            createdAt: new Date().toISOString(),
            eval: critique.eval,
          },
        ],
      };
    }

    const question = result.text.trim();
    if (!question) {
      throw new StageFailedClosedError("Intake model produced no question and no summary.");
    }
    setIntakeData(state, { phase: "awaiting_answer" });
    return awaitingQuestion(ctx, state, question);
  }

  throw new StageFailedClosedError("Intake hit the step cap without a valid summary.", {
    projectId: ctx.project.id,
    clientId: ctx.project.clientId,
  });
}

export const runIntakeReentrant = {
  async start(ctx: StageContext): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId) ?? createIntakeState(ctx);
    const pending = pendingInteraction(ctx.project, state.pendingInteractionId);
    if (pending) return { status: "awaiting_input", state, interaction: pending };
    if (!state.messages.length) {
      setIntakeData(state, { phase: "awaiting_initial_idea" });
      return awaitingQuestion(
        ctx,
        state,
        "Tell me about the idea you want to build, in your own words.",
      );
    }
    return continueIntake(ctx, state);
  },

  async resume(ctx: StageContext, response: InteractionResponse): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId) ?? createIntakeState(ctx);
    if (state.pendingInteractionId !== response.interactionId) {
      throw new StageFailedClosedError("Interaction does not match the pending Intake state.", {
        expected: state.pendingInteractionId,
        received: response.interactionId,
      });
    }
    const answer = response.text?.trim();
    if (!answer) {
      throw new StageFailedClosedError("Intake interaction response was empty.", {
        interactionId: response.interactionId,
      });
    }
    const data = intakeData(state);
    state.pendingInteractionId = undefined;
    if (data.phase === "awaiting_followup_answer") {
      state.messages.push({
        role: "user",
        content: `Critic follow-up answers:\n${answer}`,
      });
    } else {
      state.messages.push({ role: "user", content: answer });
    }
    setIntakeData(state, { phase: "model_turn" });
    saveStageExecutionState(ctx.project, ctx.stageId, state);
    return continueIntake(ctx, state);
  },
};

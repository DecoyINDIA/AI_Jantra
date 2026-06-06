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

/**
 * Intake stage, redesigned per the Intake Stage Redesign brief.
 *
 * Intake is deliberately lightweight and exploratory. It captures the raw idea,
 * pins down the problem only when unclear, and always captures two anchors that
 * the Research stage later uses to frame viability: build_philosophy (what the
 * founder wants to build toward) and founder_philosophy (why they are building).
 * Viability, market validation, and path recommendation are Research's job, not
 * Intake's. The agent never asks for exact figures and uses category options for
 * any sensitive or open-ended input.
 */

export const BUILD_PHILOSOPHY = {
  mvp_pitch: "Bare-bones MVP to validate and pitch",
  lean_profitable: "Lean build, self-funded, profitable early",
  premium_experience: "Premium product with strong user experience",
  exploring: "Still exploring, not sure yet",
} as const;

export const FOUNDER_PHILOSOPHY = {
  self_experienced: "I experienced this problem myself",
  lifestyle: "I want financial independence or a lifestyle business",
  scale_exit: "I want to build, grow, and eventually exit",
  mission_driven: "I am passionate about a specific mission or cause",
  opportunistic: "I see a market opportunity and want to capture it",
} as const;

const CONSTRAINT_FLAGS = {
  speed_over_cost: "Speed matters more than cost right now",
  limited_tech: "Limited technical resources or no tech team yet",
  regulatory: "Known regulations or compliance requirements in this space",
  geo_language: "Needs to work in a specific geography or language",
  none: "No major constraints that I know of",
} as const;

const buildPhilosophyKeys = Object.keys(BUILD_PHILOSOPHY) as [keyof typeof BUILD_PHILOSOPHY];
const founderPhilosophyKeys = Object.keys(FOUNDER_PHILOSOPHY) as [
  keyof typeof FOUNDER_PHILOSOPHY,
];
const constraintFlagKeys = Object.keys(CONSTRAINT_FLAGS) as [keyof typeof CONSTRAINT_FLAGS];

/** Up to two critic-driven follow-up rounds before the stage fails closed. */
const MAX_FOLLOWUP_ROUNDS = 2;

function optionsBlock(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, label]) => `  - ${key}: ${label}`)
    .join("\n");
}

const SYSTEM_PROMPT = `You are the Intake specialist at Xolver, a studio that turns ideas into built products.

Your job is to understand a founder's idea well enough that a research team can investigate it with intention. You are the first touchpoint, so be warm, concise, and direct.

How to work:
- Ask focused questions, one or two at a time. Never ask more than two at once.
- Follow the funnel: each answer shapes the next question. Do not ask what is already known.
- For questions about constraints, budgets, or capacity: use categories, not exact figures.
- You must capture build_philosophy (what they want to build toward) and founder_philosophy (why they are building this). These are required fields.
- If the founder does not know the answer to something, record it as an open question for Research. Do not pressure them.
- When you have enough to fill the Idea Summary schema, call submit_idea_summary.

What you must NOT do:
- Do not assess market viability. That is Research's job.
- Do not suggest which path to take. That is Research's job after seeing the data.
- Do not invent features, users, or constraints the founder did not mention.
- Do not use em dashes.

Tone: plain, warm, concrete. Short sentences. No filler.

Required category questions. When you ask these, present the options explicitly in the question text and store the chosen key.

build_philosophy - "What is your primary goal for this build right now?"
${optionsBlock(BUILD_PHILOSOPHY)}

founder_philosophy - "What is driving this idea for you personally? Pick the closest fit."
${optionsBlock(FOUNDER_PHILOSOPHY)}

constraints_flags (optional, ask only if the idea involves real resource or regulatory complexity) - "Are there any constraints we should keep in mind as we research? Select all that apply."
${optionsBlock(CONSTRAINT_FLAGS)}`;

const ideaSummarySchema = z.object({
  title: z.string().min(3),
  raw_idea: z.string().min(20),
  problem: z.string().min(10),
  solution: z.string().min(10),
  target_users: z.string().min(5),
  build_philosophy: z.enum(buildPhilosophyKeys),
  founder_philosophy: z.enum(founderPhilosophyKeys),
  constraints_flags: z.array(z.enum(constraintFlagKeys)).default([]),
  key_features: z.array(z.string().min(3)).min(1),
  open_questions: z.array(z.string()).default([]),
});

type IdeaSummary = z.infer<typeof ideaSummarySchema>;

const intakeCritiqueSchema = z.object({
  scores: z.object({
    specificity: z.number().min(1).max(5),
    researchability: z.number().min(1).max(5),
    noInventedDetails: z.number().min(1).max(5),
    philosophyCaptured: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
  followUpQuestions: z.array(z.string()).default([]),
});

const intakeRubric = {
  id: "intake",
  passingScore: 4,
  criteria: ["specificity", "researchability", "noInventedDetails", "philosophyCaptured"],
};

const submitTool: ToolSpec = {
  name: "submit_idea_summary",
  description:
    "Submit the final structured summary of the founder's idea. Only call this once you understand the idea well enough for a research team to investigate it, and once build_philosophy and founder_philosophy are captured.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short name for the idea, inferred or confirmed." },
      raw_idea: {
        type: "string",
        description: "The founder's original words describing the idea, unedited.",
      },
      problem: {
        type: "string",
        description: "The core problem being solved, with user context if provided.",
      },
      solution: { type: "string", description: "The proposed solution in plain terms." },
      target_users: {
        type: "string",
        description: "Who this is for, as specific as the founder has described.",
      },
      build_philosophy: {
        type: "string",
        enum: Object.keys(BUILD_PHILOSOPHY),
        description:
          "The founder's primary goal for this build (Q3). One of the four category keys.",
      },
      founder_philosophy: {
        type: "string",
        enum: Object.keys(FOUNDER_PHILOSOPHY),
        description:
          "What is driving the idea for the founder personally (Q4). One of the five category keys.",
      },
      constraints_flags: {
        type: "array",
        items: { type: "string", enum: Object.keys(CONSTRAINT_FLAGS) },
        description: "Selected constraint signals (Q5), or an empty array.",
      },
      key_features: {
        type: "array",
        items: { type: "string" },
        description: "The must-have features as described by the founder. At least one.",
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
        description:
          "Things still unresolved that Research should investigate. Auto-generate if the founder has not stated any.",
      },
    },
    required: [
      "title",
      "raw_idea",
      "problem",
      "solution",
      "target_users",
      "build_philosophy",
      "founder_philosophy",
      "key_features",
      "open_questions",
    ],
    additionalProperties: false,
  },
};

function renderSummary(s: IdeaSummary): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none noted)";
  const constraints = s.constraints_flags.length
    ? s.constraints_flags.map((flag) => `- ${CONSTRAINT_FLAGS[flag]}`).join("\n")
    : "- None flagged";
  return `# Idea summary - ${s.title}

## Raw idea
${s.raw_idea}

## Problem
${s.problem}

## Solution
${s.solution}

## Target users
${s.target_users}

## Key features
${list(s.key_features)}

## Build philosophy
${BUILD_PHILOSOPHY[s.build_philosophy]} (${s.build_philosophy})

## Founder philosophy
${FOUNDER_PHILOSOPHY[s.founder_philosophy]} (${s.founder_philosophy})

## Constraints
${constraints}

## Open questions
${list(s.open_questions)}

<!-- anchors: build_philosophy=${s.build_philosophy}; founder_philosophy=${s.founder_philosophy} -->
`;
}

/**
 * Deterministic required-field checks (brief 5.1). These do not fail the stage
 * closed: a gap turns into a targeted follow-up question. Enum and length
 * constraints are enforced by the schema itself; here we catch the semantic
 * gaps a schema cannot express.
 */
function deterministicFollowUps(s: IdeaSummary): string[] {
  const followUps: string[] = [];
  const problem = s.problem.trim().toLowerCase();
  const solution = s.solution.trim().toLowerCase();
  if (solution === problem || solution.includes(problem) || problem.includes(solution)) {
    followUps.push(
      "What would your solution actually do that is different from just restating the problem?",
    );
  }
  return followUps;
}

async function critiqueSummary(
  ctx: StageContext,
  summary: IdeaSummary,
): Promise<{ eval: EvalScore; followUpQuestions: string[] }> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system:
      "You are the Intake critic. After schema validation, score the idea summary on specificity (concrete problem anchored to a real user in a real context), researchability (enough anchors for targeted queries), noInventedDetails (no market claims or features the founder did not mention), and philosophyCaptured (build_philosophy and founder_philosophy are present and consistent with the idea). All four must score 4 or above to pass. If any is below 4, return at most 2 targeted follow-up questions rather than rejecting outright. Return only JSON.",
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
  const evalScore = makeEvalScore(intakeRubric, parsed.data.scores, parsed.data.notes);
  evalScore.passed = evalScore.passed && parsed.data.passed;
  return { eval: evalScore, followUpQuestions: parsed.data.followUpQuestions };
}

type SubmissionOutcome =
  | { kind: "complete"; summary: IdeaSummary; eval: EvalScore }
  | { kind: "followups"; questions: string[]; eval: EvalScore }
  | { kind: "fail"; eval: EvalScore };

/**
 * Validate a submitted summary, run the critic, and decide the next move:
 * complete, ask up to two follow-ups, or fail closed once the follow-up budget
 * is spent. Recording the eval is centralized here so both runners stay in sync.
 */
async function evaluateSubmission(
  ctx: StageContext,
  rawArgs: unknown,
  roundsUsed: number,
): Promise<SubmissionOutcome> {
  const parsed = ideaSummarySchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new SchemaValidationError("Idea summary failed schema validation.", {
      issues: parsed.error.issues,
    });
  }
  const summary = parsed.data;

  const deterministic = deterministicFollowUps(summary);
  const critique = await critiqueSummary(ctx, summary);

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

  const passed = critique.eval.passed && deterministic.length === 0;
  if (passed) {
    return { kind: "complete", summary, eval: critique.eval };
  }

  const questions = [...deterministic, ...critique.followUpQuestions].slice(0, 2);
  if (questions.length && roundsUsed < MAX_FOLLOWUP_ROUNDS) {
    return { kind: "followups", questions, eval: critique.eval };
  }
  return { kind: "fail", eval: critique.eval };
}

function summaryArtifact(ctx: StageContext, summary: IdeaSummary, evalScore: EvalScore): Artifact {
  return {
    stage: ctx.stageId,
    kind: "idea_summary",
    title: summary.title,
    content: renderSummary(summary),
    version: 1,
    createdAt: new Date().toISOString(),
    eval: evalScore,
  };
}

export async function runIntake(ctx: StageContext): Promise<Artifact[]> {
  const { provider, audit, io, project } = ctx;

  io.say(
    "Hi, I'm the Xolver intake assistant. Tell me about the idea you want to build, in your own words. There are no wrong answers here.",
  );
  const firstIdea = await io.ask("your idea");

  const messages: ModelMessage[] = [{ role: "user", content: firstIdea }];
  let followUpRounds = 0;

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
      const outcome = await evaluateSubmission(ctx, submit.args, followUpRounds);

      if (outcome.kind === "followups") {
        followUpRounds++;
        io.say("\nI need to tighten a couple of details before I can hand this forward.");
        const answers: string[] = [];
        for (const question of outcome.questions) {
          answers.push(`${question}\n${await io.ask(question)}`);
        }
        messages.push({
          role: "user",
          content: `Critic follow-up answers:\n${answers.join("\n\n")}`,
        });
        continue;
      }

      if (outcome.kind === "fail") {
        throw new StageFailedClosedError("Intake summary did not pass its rubric.", {
          projectId: project.id,
          clientId: project.clientId,
          eval: outcome.eval,
        });
      }

      audit.record("agent_message", {
        clientId: project.clientId,
        projectId: project.id,
        stage: ctx.stageId,
        step,
        summary: outcome.summary,
      });
      io.say("\nThanks, that's everything I need. I've written up a summary.");
      project.title = outcome.summary.title;
      return [summaryArtifact(ctx, outcome.summary, outcome.eval)];
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
  followUpRounds?: number;
}

function intakeData(state: PersistedStageState): IntakeStateData {
  const phase =
    typeof state.data.phase === "string" ? state.data.phase : "awaiting_initial_idea";
  return {
    phase: phase as IntakePhase,
    followUpQuestions: Array.isArray(state.data.followUpQuestions)
      ? state.data.followUpQuestions.filter((value): value is string => typeof value === "string")
      : undefined,
    followUpRounds:
      typeof state.data.followUpRounds === "number" ? state.data.followUpRounds : 0,
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
    followUpRounds: 0,
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
      const roundsUsed = intakeData(state).followUpRounds ?? 0;
      const outcome = await evaluateSubmission(ctx, submit.args, roundsUsed);

      if (outcome.kind === "followups") {
        setIntakeData(state, {
          phase: "awaiting_followup_answer",
          followUpQuestions: outcome.questions,
          followUpRounds: roundsUsed + 1,
        });
        return awaitingQuestion(
          ctx,
          state,
          `I need to tighten a couple of details before I can hand this forward.\n\n${outcome.questions.join(
            "\n",
          )}`,
        );
      }

      if (outcome.kind === "fail") {
        throw new StageFailedClosedError("Intake summary did not pass its rubric.", {
          projectId: ctx.project.id,
          clientId: ctx.project.clientId,
          eval: outcome.eval,
        });
      }

      ctx.project.title = outcome.summary.title;
      setIntakeData(state, { phase: "complete" });
      saveStageExecutionState(ctx.project, ctx.stageId, state);
      return {
        status: "awaiting_confirmation",
        state,
        artifacts: [summaryArtifact(ctx, outcome.summary, outcome.eval)],
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
        "Tell me about the idea you want to build, in your own words. There are no wrong answers here.",
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

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
import { enforceIntakeRunCeiling, recordIntakeSpend } from "../../runtime/intakeBudget.js";
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
const INTAKE_GENERATOR_OUTPUT_TOKENS = 2500;
const INTAKE_CRITIQUE_OUTPUT_TOKENS = 1800;

function optionsBlock(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, label]) => `  - ${key}: ${label}`)
    .join("\n");
}

const SYSTEM_PROMPT = `You are Manthan, the ideation guide at Xolver, a studio that turns ideas into built products.

The person you are talking to usually has only a faint idea. Often no team, no technical background, no startup, and no vocabulary for any of it. They came because the idea will not leave them alone, not because they have answers. Many are quietly worried the idea is too small or too silly to say out loud. Your whole job is to make the idea feel safe, seen, and a little more real by the end of the conversation, then hand a clear picture to the research team.

Mindset:
- Every idea is worth taking seriously. There are no wrong answers and no silly ideas.
- You are a thinking partner, not a screener and not a form. The person should never feel tested.
- They cannot fail this conversation. If they do not know something, that is normal and expected. Knowing is your job, not theirs.
- Assume no technical knowledge. Never ask how they would build it, what tech stack, team, or budget they have. They are here precisely because they do not know that yet.

The golden rule, every single turn:
1. Reflect first. Open with a sentence or two mirroring what you understood, in plain words, slightly more articulate than they said it. Being understood is what makes this feel human.
2. Never ask a naked question. Every question must come with 2 or 3 concrete guesses tailored to their idea, phrased as easy options, ending with an escape hatch like "or is it something else?". They should be able to answer by recognizing, not by composing.
3. One question per turn is ideal, two at the absolute most.

How the conversation flows:
1. Receive the idea, however rough, and reflect it back generously.
2. Fill the core gaps (who it is for, what pain it removes) by guessing, not interrogating. Offer your best readings as options they can pick from or correct.
3. Once you understand it, offer 3 to 5 concrete directions this specific idea could take. Each direction is a short label plus one plain line, tailored to their idea. Make clear they can pick one, blend a few, or describe their own.
4. When you understand the idea and the direction they lean toward, call submit_idea_summary. Close warmly; never announce the handoff like paperwork.

Scenarios to handle warmly:
- A one-line vague idea ("an app for farmers"): treat it as enough. Reflect the most generous concrete reading, then offer 2 or 3 interpretations as options.
- "Like X but for Y": use the reference. Say in plain words which part of X you think they mean, then ask which part matters most to them, as options.
- A problem with no solution: tell them a real problem is the best possible starting point. Offer 2 or 3 plain ways it could be solved and ask which feels closest.
- Technology first ("I want to do something with AI"): welcome the ambition, then steer to people. Ask who they would most like it to help, offering guesses drawn from anything they have shared about their life or work.
- "I don't know": never repeat the question. Offer your own best guess and ask if it sounds right. If they are still unsure, say that is completely fine, note it silently as an open question for research, and move on.
- "This might be a stupid idea": disagree, specifically. Name the real pain or insight inside their idea before anything else.
- Several ideas at once, or a long ramble: reflect the strongest thread you heard, then ask which one is pulling at them most, listing their own ideas back as the options.
- They ask what YOU think: answer honestly and encouragingly with one concrete observation about their idea. Never deflect with "that's up to you".
- They describe their life or job rather than an idea: find the pain inside the story and offer it back. "It sounds like the real headache is X. Should we build around that?"
- Short, simple, or imperfect English: match it. Short plain sentences. Never correct them.

Rules:
- Never re-ask something already answered, even if the answer was vague. A vague answer is still an answer; gaps go to open_questions, not back at the person.
- Never ask for exact figures. Categories or plain descriptions only.
- Do not state features, users, or facts they did not mention as if they were facts. Offering clearly framed guesses and options is encouraged; that is your main tool.
- Aim to be useful within about 3 to 5 exchanges, but if the person wants to keep exploring, stay with them. Never cut the conversation short or push them to finish.
- Warm, plain, concrete language. Short sentences. No jargon, no filler, no em dashes. Keep each reply under about 120 words. Options may be a short list; everything else is conversational prose, never headers or forms.

What you must NOT do:
- Do not assess market viability or market size. That is the research team's job.
- The directions you offer are product or strategic angles for THEIR idea, not generic business-model labels.
- Do not present the internal classifications below to the person as a quiz. They are for your summary only.

Internal classification reference. Infer these silently from the conversation. Never present them to the person as questions.

build_philosophy - what the person wants to build toward (default to "exploring" if genuinely unclear):
${optionsBlock(BUILD_PHILOSOPHY)}

founder_philosophy - why the person is building this, inferred from how they talk about it:
${optionsBlock(FOUNDER_PHILOSOPHY)}

constraints_flags - record one only if the person raised it themselves. Do not ask a constraints checklist:
${optionsBlock(CONSTRAINT_FLAGS)}

If you cannot infer something, record it as an open question for research rather than pressing them for it. Gaps are normal; the research team expects them.`;

const directionSchema = z.object({
  label: z.string().min(3).max(80),
  summary: z.string().min(8).max(240),
});

const ideaSummarySchema = z.object({
  title: z.string().min(3).max(120),
  raw_idea: z.string().min(20).max(2000),
  problem: z.string().min(10).max(700),
  solution: z.string().min(10).max(700),
  target_users: z.string().min(5).max(500),
  build_philosophy: z.enum(buildPhilosophyKeys),
  founder_philosophy: z.enum(founderPhilosophyKeys),
  constraints_flags: z.array(z.enum(constraintFlagKeys)).default([]),
  key_features: z.array(z.string().min(3).max(240)).min(1).max(8),
  proposed_directions: z.array(directionSchema).max(5).default([]),
  chosen_direction: z.string().max(300).optional(),
  open_questions: z.array(z.string().max(300)).max(8).default([]),
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
  notes: z.string().max(700),
  followUpQuestions: z.array(z.string().max(300)).max(2).default([]),
});

const intakeRubric = {
  id: "intake",
  passingScore: 4,
  criteria: ["specificity", "researchability", "noInventedDetails", "philosophyCaptured"],
};

const submitTool: ToolSpec = {
  name: "submit_idea_summary",
  description:
    "Submit the final structured summary of the founder's idea. Only call this once you understand the idea, have reflected a few tailored directions back to the person, and have inferred build_philosophy and founder_philosophy from the conversation.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        maxLength: 120,
        description: "A short name for the idea, inferred or confirmed.",
      },
      raw_idea: {
        type: "string",
        maxLength: 2000,
        description: "The founder's original words describing the idea, unedited and concise.",
      },
      problem: {
        type: "string",
        maxLength: 700,
        description: "The core problem being solved, with user context if provided.",
      },
      solution: {
        type: "string",
        maxLength: 700,
        description: "The proposed solution in plain terms.",
      },
      target_users: {
        type: "string",
        maxLength: 500,
        description: "Who this is for, as specific as the founder has described.",
      },
      build_philosophy: {
        type: "string",
        enum: Object.keys(BUILD_PHILOSOPHY),
        description:
          "The founder's primary goal for this build, inferred from the conversation. One of the four category keys.",
      },
      founder_philosophy: {
        type: "string",
        enum: Object.keys(FOUNDER_PHILOSOPHY),
        description:
          "What is driving the idea for the founder personally, inferred from how they talk about it. One of the five category keys.",
      },
      constraints_flags: {
        type: "array",
        items: { type: "string", enum: Object.keys(CONSTRAINT_FLAGS) },
        description:
          "Constraint signals the founder raised themselves, or an empty array.",
      },
      key_features: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 240 },
        description: "The must-have features as described by the founder. At least one.",
      },
      proposed_directions: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            label: { type: "string", maxLength: 80 },
            summary: { type: "string", maxLength: 240 },
          },
          required: ["label", "summary"],
          additionalProperties: false,
        },
        description:
          "The 3 to 5 directions you reflected back to the person, each a short label and one plain line. Empty if you did not reach the directions step.",
      },
      chosen_direction: {
        type: "string",
        maxLength: 300,
        description:
          "The direction the person leaned toward, in their words or a blend they described. Omit if they are still exploring.",
      },
      open_questions: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 300 },
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
  const directions = s.proposed_directions.length
    ? s.proposed_directions.map((d) => `- ${d.label}: ${d.summary}`).join("\n")
    : "- (none reflected back)";
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

## Directions explored
${directions}

## Direction they lean toward
${s.chosen_direction?.trim() ? s.chosen_direction.trim() : "Still exploring, no single direction chosen yet."}

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
      "You've described the pain really well. If this existed today, what is the first thing it would actually do for them: take a chore off their plate, show them something they can't see today, or connect them with someone? Or something else entirely?",
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
      "You are the Intake critic. The founder usually arrived with only a faint idea; the intake agent's job was to capture it warmly, not extract a complete spec. Score the idea summary on specificity (concrete problem anchored to a real user, as specific as the conversation allowed), researchability (enough anchors for targeted queries; honest open_questions count as anchors, not gaps), noInventedDetails (no market claims or features the founder did not mention; directions the agent offered and the founder chose are not inventions), and philosophyCaptured (build_philosophy and founder_philosophy are present and consistent with the idea). All four must score 4 or above to pass. A summary that is honest about what is unknown, with gaps recorded in open_questions, should pass; never penalize vagueness the founder could not resolve. Return follow-up questions (max 2) only when something essential is missing or contradictory that the founder clearly could answer. Phrase each follow-up warmly in plain language, addressed directly to the founder, with 2 or 3 candidate answers offered as easy options. Return only JSON.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(summary, null, 2),
      },
    ],
    responseJsonSchema: z.toJSONSchema(intakeCritiqueSchema),
    thinking: true,
    maxOutputTokens: INTAKE_CRITIQUE_OUTPUT_TOKENS,
    temperature: 0,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  recordIntakeSpend(ctx.store, ctx.project, ctx.stageId, result.costUsd);
  enforceIntakeRunCeiling(ctx.audit, ctx.project, ctx.stageId);
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
    "Hi, I'm Manthan. I help people shape ideas into real products, and rough, half-formed ideas are my favourite kind. Tell me what's on your mind, in your own words. Even one line is plenty. 'Something like Swiggy, but for home-cooked tiffins' is a great start.",
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
      maxOutputTokens: INTAKE_GENERATOR_OUTPUT_TOKENS,
    });
    trackStageModelCall(audit, project, ctx.stageId, "generator", result);
    recordIntakeSpend(ctx.store, project, ctx.stageId, result.costUsd);
    enforceIntakeRunCeiling(audit, project, ctx.stageId);
    messages.push(result.message);

    const submit = result.toolCalls.find((call) => call.name === "submit_idea_summary");
    if (submit) {
      const outcome = await evaluateSubmission(ctx, submit.args, followUpRounds);

      if (outcome.kind === "followups") {
        followUpRounds++;
        io.say(
          "\nThis is shaping up really nicely. Before I pass it to our research team, I'm just curious about one or two things.",
        );
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
      io.say(
        "\nI love where this landed. I've written up your idea the way I'll describe it to our research team. They'll dig in from here, and we'll come back to you with what we find.",
      );
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
      maxOutputTokens: INTAKE_GENERATOR_OUTPUT_TOKENS,
    });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);
    recordIntakeSpend(ctx.store, ctx.project, ctx.stageId, result.costUsd);
    enforceIntakeRunCeiling(ctx.audit, ctx.project, ctx.stageId);
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
          `This is shaping up really nicely. Before I pass it to our research team, I'm just curious about one or two things.\n\n${outcome.questions.join(
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
        "Hi, I'm Manthan. I help people shape ideas into real products, and rough, half-formed ideas are my favourite kind. Tell me what's on your mind, in your own words. Even one line is plenty. 'Something like Swiggy, but for home-cooked tiffins' is a great start.",
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

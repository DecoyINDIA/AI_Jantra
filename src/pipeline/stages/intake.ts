import Anthropic from "@anthropic-ai/sdk";

import { config } from "../../config.js";
import type { Artifact, StageContext } from "../types.js";

/**
 * Stage 1 — Intake. A conversational agent that draws out the client's idea
 * with focused questions, then submits a structured summary. Multi-turn: the
 * model's plain text is treated as a question to the client; a tool call ends
 * the stage with the artifact.
 */

const SYSTEM_PROMPT = `You are the intake specialist at Xolver, a studio that turns ideas into built products.

Your job: understand a client's product idea well enough that a research team and a planning team can take it forward. You are the first human-feeling touchpoint, so be warm, sharp, and brief.

How to work:
- Ask focused clarifying questions, one or two at a time. Never dump a long list.
- Cover what matters: the real problem, who has it, the proposed solution, the must-have features, constraints (budget, timeline, tech, platform), and how success is judged.
- Do not pad. If the client already answered something, do not re-ask it.
- When you genuinely understand the idea, call submit_idea_summary with a clear, structured summary. Do not call it before you have enough to research and plan.

Tone: plain, concrete, friendly. Short sentences. No em dashes. No filler.`;

interface IdeaSummary {
  title: string;
  problem: string;
  solution: string;
  targetUsers: string;
  keyFeatures: string[];
  constraints: string;
  successCriteria: string;
  openQuestions: string[];
}

const submitTool: Anthropic.Tool = {
  name: "submit_idea_summary",
  description:
    "Submit the final structured summary of the client's idea. Only call this once you understand the idea well enough for a team to research and plan it.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short name for the product/idea." },
      problem: { type: "string", description: "The real problem being solved." },
      solution: { type: "string", description: "The proposed solution, in plain terms." },
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
  } as Anthropic.Tool.InputSchema,
};

function renderSummary(s: IdeaSummary): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none noted)";
  return `# Idea summary — ${s.title}

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

export async function runIntake(ctx: StageContext): Promise<Artifact[]> {
  const { client, audit, io } = ctx;

  io.say(
    "Hi, I'm the Xolver intake assistant. Tell me about the idea you want to build, in your own words.",
  );
  const firstIdea = await io.ask("your idea");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: firstIdea },
  ];

  for (let step = 0; step < config.maxSteps; step++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: config.effort },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [submitTool],
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);

    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking) {
        audit.record("agent_thinking", { stage: "intake", step, text: block.thinking });
      }
    }
    messages.push({ role: "assistant", content: response.content });

    // The agent finished gathering and submitted the summary.
    const submit = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "submit_idea_summary",
    );
    if (submit) {
      const summary = submit.input as IdeaSummary;
      const content = renderSummary(summary);
      audit.record("agent_message", { stage: "intake", step, summary });
      io.say("\nThanks, that's everything I need. I've written up a summary.");
      return [
        {
          stage: "intake",
          kind: "idea_summary",
          title: summary.title,
          content,
          version: 1,
          createdAt: new Date().toISOString(),
        },
      ];
    }

    // Otherwise the agent asked the client something. Relay it and get a reply.
    const question = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (question) io.say("\n" + question);
    const answer = await io.ask("you");
    messages.push({ role: "user", content: answer });
  }

  // Hit the step cap without a summary — produce what we can rather than nothing.
  audit.record("error", { stage: "intake", error: "max_steps_without_summary" });
  io.say(
    "\nWe've covered a lot. I'll hand this to a teammate to finalize the summary.",
  );
  return [];
}

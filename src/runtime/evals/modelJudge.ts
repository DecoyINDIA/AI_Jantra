import { z } from "zod";

import { config } from "../../config.js";
import { createProviderForStage } from "../../model/index.js";
import { SchemaValidationError } from "../errors.js";
import type { EvalFixture } from "./fixtures.js";
import type { StageEvalResult } from "./report.js";

const modelJudgeSchema = z.object({
  scores: z.object({
    completeness: z.number().min(1).max(5),
    balance: z.number().min(1).max(5),
    entailment: z.number().min(1).max(5),
  }),
  notes: z.string(),
});

type JudgeStage = "research" | "planning";

function parseJudge(text: string): z.infer<typeof modelJudgeSchema> {
  const parsed = modelJudgeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new SchemaValidationError("Model judge output failed schema validation.", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function average(scores: Record<string, number>): number {
  const values = Object.values(scores);
  return values.reduce((sum, score) => sum + score, 0) / values.length;
}

async function judgeFixture(
  fixture: EvalFixture,
  stage: JudgeStage,
): Promise<StageEvalResult> {
  const provider = createProviderForStage(stage, stage === "planning" ? "pro" : "flash");
  const result = await provider.generate({
    purpose: "eval_model_judge",
    system:
      "You are a supplementary Jantra eval judge. Score judgment-heavy quality only. Do not generate product artifacts. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `Stage to judge: ${stage}

Idea:
${fixture.idea}

Expected anchors:
Users: ${fixture.expected.users.join(", ")}
Features: ${fixture.expected.features.join(", ")}
Risks: ${fixture.expected.risks.join(", ")}

Score completeness, balance, and entailment from 1 to 5. This is advisory and does not replace deterministic gates.`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(modelJudgeSchema),
    thinking: false,
    temperature: 0,
    maxOutputTokens: 1500,
  });
  const parsed = parseJudge(result.text);
  return {
    fixtureId: `${fixture.id}-model-judge`,
    stage,
    score: Number(average(parsed.scores).toFixed(1)),
    passed: true,
    notes: `Supplementary model judge: ${JSON.stringify(parsed.scores)}. ${parsed.notes}`,
  };
}

export async function runModelJudgeEvals(
  fixtures: EvalFixture[],
): Promise<StageEvalResult[]> {
  if (!config.geminiApiKey || config.provider === "mock") {
    return [
      {
        fixtureId: "model-judge",
        stage: "research",
        score: 0,
        passed: true,
        skipped: true,
        notes: "GEMINI_API_KEY is not set, supplementary model judges skipped.",
      },
    ];
  }

  const results: StageEvalResult[] = [];
  for (const fixture of fixtures) {
    results.push(await judgeFixture(fixture, "research"));
    results.push(await judgeFixture(fixture, "planning"));
  }
  return results;
}

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
  let cleaned = text.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    cleaned = cleaned.slice(start, end + 1);
  }

  let rawObj: any;
  try {
    rawObj = JSON.parse(cleaned);
  } catch (err) {
    throw new SchemaValidationError(
      `Model judge output is not valid JSON. Raw response: ${text}`,
      { raw: text, cause: err },
    );
  }

  if (rawObj && typeof rawObj === "object" && !rawObj.scores) {
    if (
      (typeof rawObj.completeness === "number" || typeof rawObj.completeness === "string") &&
      (typeof rawObj.balance === "number" || typeof rawObj.balance === "string") &&
      (typeof rawObj.entailment === "number" || typeof rawObj.entailment === "string")
    ) {
      rawObj.scores = {
        completeness: Number(rawObj.completeness),
        balance: Number(rawObj.balance),
        entailment: Number(rawObj.entailment),
      };
    }
  }

  const parsed = modelJudgeSchema.safeParse(rawObj);
  if (!parsed.success) {
    throw new SchemaValidationError(`Model judge output failed schema validation. Raw response: ${text}`, {
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
  try {
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
    const avgScore = Number(average(parsed.scores).toFixed(1));
    return {
      fixtureId: `${fixture.id}-model-judge`,
      stage,
      score: avgScore,
      passed: avgScore >= 3.0,
      notes: `Supplementary model judge: ${JSON.stringify(parsed.scores)}. ${parsed.notes}`,
    };
  } catch (err) {
    if (config.runLiveJudge) {
      return {
        fixtureId: `${fixture.id}-model-judge`,
        stage,
        score: 0,
        passed: false,
        skipped: false,
        notes: `Live model judge failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      fixtureId: `${fixture.id}-model-judge`,
      stage,
      score: 0,
      passed: true,
      skipped: true,
      notes: `Live model judge unreachable or failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runModelJudgeEvals(
  fixtures: EvalFixture[],
): Promise<StageEvalResult[]> {
  if (!config.runLiveJudge) {
    return [
      {
        fixtureId: "model-judge",
        stage: "research",
        score: 0,
        passed: true,
        skipped: true,
        notes: "Live model judging is disabled by default (enable with JANTRA_RUN_LIVE_JUDGE=1).",
      },
    ];
  }

  const hasCredentials =
    (config.provider === "gemini" && Boolean(config.geminiApiKey)) ||
    (config.provider === "openai-compatible" && Boolean(config.llmApiKey));

  if (!hasCredentials) {
    return [
      {
        fixtureId: "model-judge",
        stage: "research",
        score: 0,
        passed: false,
        skipped: false,
        notes: `Live model judging is explicitly enabled, but no valid API credentials are configured for provider "${config.provider}".`,
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

import { fixtures } from "./fixtures.js";
import {
  judgeEvaluatorLoopRefinement,
  judgeIntakeFixture,
  judgePlanningConsistency,
  judgeResearchVerification,
  judgeResearchSourceSelection,
} from "./judge.js";
import { runModelJudgeEvals } from "./modelJudge.js";
import { runRegressionEvals } from "./regressions.js";
import { renderEvalReport, type StageEvalResult } from "./report.js";
import { rubrics } from "./rubrics.js";
import { runOpsEvaluation } from "./opsEvals.js";

function validateRubrics(): StageEvalResult[] {
  return Object.entries(rubrics).map(([stage, rubric]) => ({
    fixtureId: "rubric-registry",
    stage: stage as StageEvalResult["stage"],
    score: rubric.criteria.length >= 4 ? 5 : 1,
    passed: rubric.criteria.length >= 4,
    notes: `${rubric.id} rubric has ${rubric.criteria.length} criteria.`,
  }));
}

export async function runEvalSuite(): Promise<StageEvalResult[]> {
  const results: StageEvalResult[] = [...validateRubrics()];
  for (const fixture of fixtures) {
    results.push(judgeIntakeFixture(fixture));
    results.push(judgeResearchVerification(fixture));
    results.push(judgePlanningConsistency(fixture));
  }
  results.push(judgeResearchSourceSelection());
  results.push(await judgeEvaluatorLoopRefinement());
  results.push(...(await runModelJudgeEvals(fixtures)));
  results.push(...(await runRegressionEvals()));
  results.push(...runOpsEvaluation());
  return results;
}

const results = await runEvalSuite();
console.log(renderEvalReport(results));
if (results.some((result) => !result.skipped && !result.passed)) {
  process.exitCode = 1;
}

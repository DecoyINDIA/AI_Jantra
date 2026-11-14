process.env.JANTRA_PROVIDER ??= "mock";
process.env.JANTRA_MOCK_FIXTURE ??= "src/runtime/evals/fixtures/transcript.json";

const { fixtures } = await import("./fixtures.js");
const {
  judgeEvaluatorLoopRefinement,
  judgeIntakeFixture,
  judgePlanningConsistency,
  judgeResearchVerification,
  judgeResearchSourceSelection,
} = await import("./judge.js");
const { runModelJudgeEvals } = await import("./modelJudge.js");
const { runRegressionEvals } = await import("./regressions.js");
const { renderEvalReport } = await import("./report.js");
type StageEvalResult = import("./report.js").StageEvalResult;
const { rubrics } = await import("./rubrics.js");
const { runOpsEvaluation } = await import("./opsEvals.js");

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

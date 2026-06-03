import type { AuditLogger } from "../audit.js";
import type { ModelProvider } from "../model/provider.js";
import type { EvalScore, Project, StageId } from "../pipeline/types.js";
import { StageFailedClosedError } from "./errors.js";

export interface Rubric {
  id: string;
  passingScore: number;
  criteria: string[];
}

export interface Critique<TDraft> {
  eval: EvalScore;
  feedback: string;
  draft: TDraft;
}

export interface EvaluatorLoopOptions<TDraft> {
  audit: AuditLogger;
  project: Project;
  stage: StageId;
  rubric: Rubric;
  maxRounds: number;
  generate: () => Promise<TDraft>;
  critique: (draft: TDraft, provider: ModelProvider) => Promise<Critique<TDraft>>;
  refine: (draft: TDraft, critique: Critique<TDraft>) => Promise<TDraft>;
  provider: ModelProvider;
}

export function passedScore(scores: Record<string, number>, passingScore: number): boolean {
  const values = Object.values(scores);
  if (!values.length) return false;
  return values.every((score) => score >= passingScore);
}

export function makeEvalScore(
  rubric: Rubric,
  scores: Record<string, number>,
  notes: string,
): EvalScore {
  return {
    rubric: rubric.id,
    scores,
    passed: passedScore(scores, rubric.passingScore),
    notes,
  };
}

export async function runEvaluatorLoop<TDraft>(
  opts: EvaluatorLoopOptions<TDraft>,
): Promise<{ draft: TDraft; eval: EvalScore }> {
  let draft = await opts.generate();
  let lastEval: EvalScore | null = null;

  for (let round = 1; round <= opts.maxRounds; round++) {
    const critique = await opts.critique(draft, opts.provider);
    lastEval = critique.eval;
    opts.audit.record("eval_score", {
      clientId: opts.project.clientId,
      projectId: opts.project.id,
      stage: opts.stage,
      rubric: critique.eval.rubric,
      round,
      scores: critique.eval.scores,
      passed: critique.eval.passed,
      notes: critique.eval.notes,
    });
    const stage = opts.project.stages[opts.stage];
    if (stage) stage.evals.push(critique.eval);

    if (critique.eval.passed) {
      return { draft, eval: critique.eval };
    }

    if (round < opts.maxRounds) {
      draft = await opts.refine(draft, critique);
    }
  }

  throw new StageFailedClosedError("Draft failed its rubric within the stage budget.", {
    projectId: opts.project.id,
    clientId: opts.project.clientId,
    stage: opts.stage,
    rubric: opts.rubric.id,
    lastEval,
  });
}

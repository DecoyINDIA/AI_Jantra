import type { Rubric } from "../../runtime/evaluator.js";

export const researchRubric: Rubric = {
  id: "research",
  passingScore: 4,
  criteria: [
    "factualAccuracy",
    "citationAccuracy",
    "completeness",
    "sourceQuality",
    "balance",
  ],
};

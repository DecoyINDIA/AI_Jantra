import type { Rubric } from "../../runtime/evaluator.js";

export const planningRubric: Rubric = {
  id: "planning",
  passingScore: 4,
  criteria: [
    "completeness",
    "internalConsistency",
    "grounding",
    "technicalSoundness",
    "actionability",
  ],
};

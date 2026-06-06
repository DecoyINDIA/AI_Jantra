import { researchRubric } from "../../pipeline/research/rubric.js";
import { planningRubric } from "../../pipeline/planning/rubric.js";
import type { Rubric } from "../evaluator.js";

export const intakeRubric: Rubric = {
  id: "intake",
  passingScore: 4,
  criteria: ["specificity", "researchability", "noInventedDetails", "philosophyCaptured"],
};

export const rubrics = {
  intake: intakeRubric,
  research: researchRubric,
  planning: planningRubric,
};

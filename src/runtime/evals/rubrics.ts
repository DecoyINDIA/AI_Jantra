import { researchRubric } from "../../pipeline/research/rubric.js";
import { planningRubric } from "../../pipeline/planning/rubric.js";
import type { Rubric } from "../evaluator.js";

export const intakeRubric: Rubric = {
  id: "intake",
  passingScore: 4,
  criteria: ["specificity", "researchability", "noInventedDetails", "philosophyCaptured"],
};

export const profileRubric: Rubric = {
  id: "ops-profile",
  passingScore: 4,
  criteria: ["factualFidelity", "completeness", "honestGapsDiscipline", "actionability"],
};

export const kpiDesignRubric: Rubric = {
  id: "ops-kpi-design",
  passingScore: 4,
  criteria: ["computability", "relevance", "formulaCorrectness", "noVanity"],
};

export const sourceBindingRubric: Rubric = {
  id: "ops-source-binding",
  passingScore: 4,
  criteria: ["reconciliation", "computability", "duplicateHandling", "completeness"],
};

export const reportCompositionRubric: Rubric = {
  id: "ops-report-composition",
  passingScore: 4,
  criteria: ["numericalFidelity", "faithfulness", "readiness", "audienceFit"],
};

export const rubrics = {
  intake: intakeRubric,
  research: researchRubric,
  planning: planningRubric,
  "ops-profile": profileRubric,
  "ops-kpi-design": kpiDesignRubric,
  "ops-source-binding": sourceBindingRubric,
  "ops-report-composition": reportCompositionRubric,
};

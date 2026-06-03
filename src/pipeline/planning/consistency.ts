import type { PlanningDocument } from "./schemas.js";

export interface ConsistencyResult {
  passed: boolean;
  issues: string[];
}

function joined(document: PlanningDocument): string {
  return document.sections.map((section) => `${section.heading}\n${section.body}`).join("\n");
}

function referencedRequirementIds(document: PlanningDocument): Set<string> {
  return new Set(document.sections.flatMap((section) => section.requirementIds));
}

function checkUnknownRequirementRefs(
  label: string,
  knownIds: Set<string>,
  referencedIds: Set<string>,
  issues: string[],
): void {
  for (const id of referencedIds) {
    if (!knownIds.has(id)) {
      issues.push(`${label} references unknown requirement ${id}.`);
    }
  }
}

export function checkCrossDocumentConsistency(
  prd: PlanningDocument,
  trd: PlanningDocument,
  buildPlan: PlanningDocument,
): ConsistencyResult {
  const issues: string[] = [];
  const prdText = joined(prd).toLowerCase();
  const trdText = joined(trd).toLowerCase();
  const buildText = joined(buildPlan).toLowerCase();
  const prdRequirementIds = prd.requirements.map((requirement) => requirement.id);
  const knownRequirementIds = new Set(prdRequirementIds);
  const trdRequirementIds = referencedRequirementIds(trd);
  const buildRequirementIds = referencedRequirementIds(buildPlan);

  if (!prd.requirements.length) {
    issues.push("PRD has no requirement IDs.");
  }
  for (let index = 0; index < prd.requirements.length; index++) {
    const requirement = prd.requirements[index];
    const expected = `req-${index + 1}`;
    if (requirement && requirement.id !== expected) {
      issues.push(`PRD requirement ${requirement.id} should be ${expected}.`);
    }
  }
  if (knownRequirementIds.size !== prdRequirementIds.length) {
    issues.push("PRD has duplicate requirement IDs.");
  }
  for (const id of prdRequirementIds) {
    if (!trdRequirementIds.has(id)) issues.push(`${id} not covered by TRD.`);
    if (!buildRequirementIds.has(id)) issues.push(`${id} not covered by build plan.`);
  }
  checkUnknownRequirementRefs("TRD", knownRequirementIds, trdRequirementIds, issues);
  checkUnknownRequirementRefs("Build plan", knownRequirementIds, buildRequirementIds, issues);

  for (const keyword of ["user", "requirement", "success", "risk"]) {
    if (!prdText.includes(keyword)) issues.push(`PRD is missing ${keyword}.`);
  }
  for (const keyword of ["architecture", "data", "security", "integration"]) {
    if (!trdText.includes(keyword)) issues.push(`TRD is missing ${keyword}.`);
  }
  for (const keyword of ["milestone", "acceptance", "sequence", "risk"]) {
    if (!buildText.includes(keyword)) issues.push(`Build plan is missing ${keyword}.`);
  }
  if (!buildText.includes("prd")) issues.push("Build plan does not explicitly trace to the PRD.");
  if (!trdText.includes("prd")) issues.push("TRD does not explicitly trace to the PRD.");

  return { passed: issues.length === 0, issues };
}

import type { AuditLogger } from "../audit.js";
import { config } from "../config.js";
import { CostCeilingExceededError } from "./errors.js";
import type { ModelResult } from "../model/provider.js";
import type { CostRollup, Project, StageCost, StageId } from "../pipeline/types.js";

export function emptyStageCost(): StageCost {
  return {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
    groundedPrompts: 0,
  };
}

export function emptyCostRollup(stageIds: string[] = []): CostRollup {
  const perStage: Record<string, StageCost> = {};
  for (const stageId of stageIds) {
    perStage[stageId] = emptyStageCost();
  }
  return {
    ...emptyStageCost(),
    perStage,
  };
}

function addToCost(target: StageCost, result: ModelResult): void {
  target.usd += result.costUsd;
  target.inputTokens += result.usage.inputTokens;
  target.outputTokens += result.usage.outputTokens;
  target.cachedTokens += result.usage.cachedTokens;
  target.thinkingTokens += result.usage.thinkingTokens;
  target.groundedPrompts += result.usage.groundedPrompts;
}

export function applyModelCost(project: Project, stage: StageId, result: ModelResult): void {
  addToCost(project.cost, result);
  project.cost.perStage[stage] ??= emptyStageCost();
  addToCost(project.cost.perStage[stage], result);
}

function formatUsd(value: number): string {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}

export function assertUnderCostCeiling(project: Project): void {
  if (project.cost.usd <= config.costCeilingUsd) return;
  throw new CostCeilingExceededError(
    `Project exceeded cost ceiling of $${formatUsd(config.costCeilingUsd)}.`,
    {
      projectId: project.id,
      clientId: project.clientId,
      totalUsd: project.cost.usd,
      ceilingUsd: config.costCeilingUsd,
    },
  );
}

export function recordModelCall(
  audit: AuditLogger,
  project: Project | null,
  stage: StageId | null,
  purpose: string,
  result: ModelResult,
): void {
  audit.record("model_call", {
    clientId: project?.clientId,
    projectId: project?.id,
    stage,
    purpose,
    provider: result.provider,
    modelId: result.modelId,
    usage: result.usage,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    citationCount: result.citations.length,
    toolCallCount: result.toolCalls.length,
    cache: result.cache,
  });
  if (result.thinking) {
    audit.record("agent_thinking", {
      clientId: project?.clientId,
      projectId: project?.id,
      stage,
      purpose,
      text: result.thinking,
    });
  }
}

export function trackStageModelCall(
  audit: AuditLogger,
  project: Project,
  stage: StageId,
  purpose: string,
  result: ModelResult,
): void {
  applyModelCost(project, stage, result);
  recordModelCall(audit, project, stage, purpose, result);
  audit.record("cost_rollup", {
    clientId: project.clientId,
    projectId: project.id,
    stage,
    cost: project.cost,
  });
  assertUnderCostCeiling(project);
}

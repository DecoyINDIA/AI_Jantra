import { AuditLogger } from "../audit.js";
import { config } from "../config.js";
import type { ProjectStore } from "../pipeline/store.js";
import type { Project, StageId } from "../pipeline/types.js";
import { CostCeilingExceededError } from "./errors.js";

export const PUBLIC_INTAKE_AGENT_ID = "intake-public";

export function intakeBudgetDayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function intakeBudgetAuditRunId(clientId: string, dayUtc: string): string {
  const safeClientId = clientId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `intake-budget-${safeClientId}-${dayUtc}`;
}

export function isPublicIdeationProject(project: Project): boolean {
  return project.agentId === PUBLIC_INTAKE_AGENT_ID;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function recordIntakeSpend(
  store: ProjectStore,
  project: Project,
  stage: StageId,
  deltaUsd: number,
): void {
  if (stage !== "intake" || !isPublicIdeationProject(project) || deltaUsd <= 0) return;
  store.addClientDailyIdeationSpend(
    project.clientId,
    intakeBudgetDayUtc(),
    roundUsd(deltaUsd),
  );
}

export function enforceIntakeRunCeiling(
  audit: AuditLogger,
  project: Project,
  stage: StageId,
): void {
  const ceilingUsd = config.intakeRunCeilingUsd;
  if (stage !== "intake" || ceilingUsd <= 0) return;
  const costUsd = project.cost.perStage[stage]?.usd ?? 0;
  if (costUsd < ceilingUsd) return;
  audit.record("cost_ceiling_exceeded", {
    scope: "intake_session",
    clientId: project.clientId,
    projectId: project.id,
    costUsd: roundUsd(costUsd),
    ceilingUsd,
  });
  throw new CostCeilingExceededError("Intake ideation budget reached.", {
    scope: "intake_session",
    projectId: project.id,
    clientId: project.clientId,
    costUsd,
    ceilingUsd,
  });
}

export function clientDailyIdeationBudgetStatus(
  store: ProjectStore,
  clientId: string,
  now = new Date(),
): { exceeded: boolean; spend: number; ceiling: number; day: string } {
  const day = intakeBudgetDayUtc(now);
  const ceiling = config.intakeClientDailyCeilingUsd;
  const spend = roundUsd(store.getClientDailyIdeationSpend(clientId, day));
  return {
    exceeded: ceiling > 0 && spend >= ceiling,
    spend,
    ceiling,
    day,
  };
}

export function auditClientDailyIdeationBudgetExceeded(
  clientId: string,
  status: { spend: number; ceiling: number; day: string },
): void {
  const audit = new AuditLogger(
    intakeBudgetAuditRunId(clientId, status.day),
    config.auditDir,
  );
  audit.record("cost_ceiling_exceeded", {
    scope: "client_daily_ideation",
    clientId,
    day: status.day,
    spend: status.spend,
    ceiling: status.ceiling,
  });
}

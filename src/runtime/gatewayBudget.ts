import { AuditLogger } from "../audit.js";
import { config } from "../config.js";
import type { ProjectStore } from "../pipeline/store.js";
import { intakeBudgetDayUtc } from "./intakeBudget.js";

export function gatewayBudgetAuditRunId(clientId: string, dayUtc: string): string {
  const safeClientId = clientId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `gateway-budget-${safeClientId}-${dayUtc}`;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function clientDailyGatewayBudgetStatus(
  store: ProjectStore,
  clientId: string,
  now = new Date(),
): { exceeded: boolean; spend: number; ceiling: number; day: string } {
  const day = intakeBudgetDayUtc(now);
  const ceiling = config.gatewayClientDailyCeilingUsd;
  const spend = roundUsd(store.getClientDailyGatewaySpend(clientId, day));
  return {
    exceeded: ceiling > 0 && spend >= ceiling,
    spend,
    ceiling,
    day,
  };
}

export function reserveGatewayBudget(
  store: ProjectStore,
  clientId: string,
  estimateUsd: number,
  now = new Date(),
): { ok: boolean; spend: number; ceiling: number; day: string } {
  const day = intakeBudgetDayUtc(now);
  const ceiling = config.gatewayClientDailyCeilingUsd;
  const spend = roundUsd(store.getClientDailyGatewaySpend(clientId, day));
  if (ceiling > 0 && roundUsd(spend + estimateUsd) > ceiling) {
    return { ok: false, spend, ceiling, day };
  }
  if (estimateUsd > 0) {
    store.addClientDailyGatewaySpend(clientId, day, roundUsd(estimateUsd));
  }
  return { ok: true, spend: roundUsd(spend + estimateUsd), ceiling, day };
}

export function settleGatewayBudget(
  store: ProjectStore,
  clientId: string,
  estimateUsd: number,
  actualUsd: number,
  day: string,
): void {
  const delta = roundUsd(actualUsd - estimateUsd);
  if (delta !== 0) {
    store.addClientDailyGatewaySpend(clientId, day, delta);
  }
}

export function recordGatewaySpend(
  store: ProjectStore,
  clientId: string,
  deltaUsd: number,
  now = new Date(),
): void {
  if (deltaUsd <= 0) return;
  const day = intakeBudgetDayUtc(now);
  store.addClientDailyGatewaySpend(clientId, day, roundUsd(deltaUsd));
}

export function auditClientDailyGatewayBudgetExceeded(
  clientId: string,
  status: { spend: number; ceiling: number; day: string },
): void {
  const audit = new AuditLogger(
    gatewayBudgetAuditRunId(clientId, status.day),
    config.auditDir,
  );
  audit.record("cost_ceiling_exceeded", {
    scope: "client_daily_gateway",
    clientId,
    day: status.day,
    spend: status.spend,
    ceiling: status.ceiling,
  });
}

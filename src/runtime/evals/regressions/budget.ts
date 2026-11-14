import { intakePublicDefinition } from "../../../agents/intakePublic.js";
import { AuditLogger } from "../../../audit.js";
import { config } from "../../../config.js";
import type { GenerateOptions, ModelResult } from "../../../model/provider.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { runIntakeReentrant } from "../../../pipeline/stages/intake.js";
import { JsonProjectStore } from "../../../pipeline/store.js";
import type { StageContext } from "../../../pipeline/types.js";
import { createServer } from "../../../server/app.js";
import { readAuditEntries } from "../../../server/events.js";
import {
  intakeBudgetAuditRunId,
  intakeBudgetDayUtc,
  visitorDailyBudgetStatus,
  visitorSpendId,
} from "../../intakeBudget.js";
import { reserveGatewayBudget, settleGatewayBudget } from "../../gatewayBudget.js";
import { assert, result, SequenceProvider } from "./common.js";

export async function verifyClientDailyIdeationBudget(): Promise<void> {
  const token = "daily-budget-regression-token";
  const day = intakeBudgetDayUtc();
  const clientId = `eval-budget-${Date.now()}`;
  const store = new JsonProjectStore();
  store.addClientDailyIdeationSpend(clientId, day, config.intakeClientDailyCeilingUsd);
  assert(
    store.getClientDailyIdeationSpend(clientId, "2099-01-01") === 0,
    "Daily ideation spend did not reset by UTC day key.",
  );
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const app = createServer({ loopbackToken: token, clientId, store });
  try {
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "intake-public",
        title: "Budget blocked intake",
      },
    });
    assert(blocked.statusCode === 429, `Daily budget did not return 429: ${blocked.body}`);
    const body = blocked.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown> | undefined;
    const details = error?.details as Record<string, unknown> | undefined;
    assert(
      error?.code === "client_daily_ideation_budget_exceeded" &&
        details?.spend === config.intakeClientDailyCeilingUsd &&
        details.ceiling === config.intakeClientDailyCeilingUsd &&
        details.day === day,
      "Daily budget response did not include the standard error envelope.",
    );
    assert(
      store.listProjects({ clientId }).items.length === 0,
      "Daily budget preflight created a run despite being exhausted.",
    );
    const audit = readAuditEntries(intakeBudgetAuditRunId(clientId, day));
    assert(
      audit.items.some(
        (entry) =>
          entry.type === "cost_ceiling_exceeded" &&
          entry.scope === "client_daily_ideation" &&
          entry.clientId === clientId &&
          entry.day === day,
      ),
      "Daily budget preflight did not audit the rejection.",
    );
  } finally {
    await app.close();
  }

  const freshClientId = `${clientId}-fresh`;
  const freshApp = createServer({ loopbackToken: token, clientId: freshClientId, store });
  try {
    const allowed = await freshApp.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "intake-public",
        title: "Budget allowed intake",
      },
    });
    assert(allowed.statusCode === 200, `Normal intake session was affected: ${allowed.body}`);
  } finally {
    await freshApp.close();
  }
}

export async function verifyIntakeSessionBudget(): Promise<void> {
  const project = createProject({
    clientId: `eval-session-budget-${Date.now()}`,
    title: "Session budget regression",
    definition: intakePublicDefinition,
  });
  const stageDefinition = project.agentDefinitionSnapshot.stages[0];
  assert(stageDefinition, "Public intake definition had no stage.");
  const store = new JsonProjectStore();
  const audit = new AuditLogger(project.id, config.auditDir);
  class CostProvider extends SequenceProvider {
    override async generate(opts: GenerateOptions): Promise<ModelResult> {
      this.requests.push(opts);
      const callCount = this.requests.length;
      return {
        ...result(callCount === 1 ? "Question one?" : "Question two?"),
        costUsd: 0.13,
      };
    }
  }
  const provider = new CostProvider([]);
  const ctx: StageContext = {
    project,
    stageId: "intake",
    stageDefinition,
    audit,
    provider,
    io: { say: () => undefined, ask: async () => "unused" },
    store,
  };

  let step = await runIntakeReentrant.start(ctx);
  assert(step.status === "awaiting_input", "Public intake did not request the first idea.");
  step = await runIntakeReentrant.resume(ctx, {
    interactionId: step.interaction.id,
    text: "A reconciliation assistant for ecommerce finance teams.",
  });
  assert(step.status === "awaiting_input", "First paid intake turn should remain under budget.");

  let blocked = false;
  try {
    await runIntakeReentrant.resume(ctx, {
      interactionId: step.interaction.id,
      text: "They use Shopify, Stripe, and QuickBooks.",
    });
  } catch (err) {
    blocked =
      err instanceof Error &&
      "code" in err &&
      err.code === "cost_ceiling_exceeded";
  }
  assert(blocked, "Crossing the intake session ceiling did not fail closed.");
  assert(provider.requests.length === 2, "Intake issued another generate after crossing budget.");
  const ceilingEvents = audit.entries.filter(
    (entry) => entry.type === "cost_ceiling_exceeded" && entry.scope === "intake_session",
  );
  assert(ceilingEvents.length === 1, "Intake session budget was not audited exactly once.");
  assert(
    store.getClientDailyIdeationSpend(project.clientId, intakeBudgetDayUtc()) === 0.26,
    "Intake daily accounting did not add model-call deltas.",
  );
}

export async function verifyGatewayDailyBudget(): Promise<void> {
  const token = "gateway-budget-token";
  const clientId = `eval-gateway-${Date.now()}`;
  const store = new JsonProjectStore();
  const app = createServer({ loopbackToken: token, clientId, store });

  const auth = { authorization: `Bearer ${token}` };

  // First request: client daily gateway budget is clean. Should succeed.
  const res1 = await app.inject({
    method: "POST",
    url: "/v1/complete",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      system: "You are a helpful assistant",
      user: "Hello",
    },
  });
  assert(res1.statusCode === 200, `First gateway complete failed: ${res1.body}`);

  // Now seed the database to exceed the gateway daily ceiling.
  const day = intakeBudgetDayUtc();
  store.addClientDailyGatewaySpend(clientId, day, 5.0);

  // Second request: client daily gateway budget is exceeded. Should fail with 429.
  const res2 = await app.inject({
    method: "POST",
    url: "/v1/complete",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      system: "You are a helpful assistant",
      user: "Hello",
    },
  });
  assert(res2.statusCode === 429, `Second gateway complete should have failed with 429, got: ${res2.statusCode}`);
  const errorObj = res2.json() as { error?: { code?: string } };
  assert(errorObj.error?.code === "gateway_daily_budget_exceeded", `Expected gateway_daily_budget_exceeded code, got: ${JSON.stringify(errorObj)}`);
}

export function verifyVisitorDailyBudget(): void {
  const store = new JsonProjectStore();
  const clientId = `test-client-${Date.now()}`;
  const key1 = "visitor-key-1";
  const key2 = "visitor-key-2";
  const day = intakeBudgetDayUtc();

  store.addClientDailyIdeationSpend(visitorSpendId(clientId, key1), day, 0.2);
  const status1 = visitorDailyBudgetStatus(store, clientId, key1);
  assert(status1.exceeded, "Expected visitor 1 budget to be exceeded");

  const status2 = visitorDailyBudgetStatus(store, clientId, key2);
  assert(!status2.exceeded, "Expected visitor 2 budget NOT to be exceeded");
}

export function verifyGatewayReserveSettle(): void {
  const store = new JsonProjectStore();
  const day = intakeBudgetDayUtc();
  const ceiling = config.gatewayClientDailyCeilingUsd;
  const estimate = config.gatewayRunCeilingUsd;

  // Case 1: seed spend so spend + estimate > ceiling -> reserve fails
  const clientIdExceed = `eval-gw-exceed-${Date.now()}`;
  const seedExceed = Number((ceiling - estimate * 0.8).toFixed(6));
  store.addClientDailyGatewaySpend(clientIdExceed, day, seedExceed);
  const resExceed = reserveGatewayBudget(store, clientIdExceed, estimate);
  assert(!resExceed.ok, `Expected reserve to fail when spend (${seedExceed}) + estimate (${estimate}) > ceiling (${ceiling})`);

  // Case 2: seed so spend + estimate <= ceiling -> reserve succeeds and spend is incremented
  const clientId2 = `eval-gw-allow-${Date.now()}`;
  const seedOk = Number((ceiling - estimate * 2).toFixed(6));
  store.addClientDailyGatewaySpend(clientId2, day, seedOk);
  const resOk = reserveGatewayBudget(store, clientId2, estimate);
  assert(resOk.ok, "Expected reserve to succeed");
  const storedAfterReserve = Number(store.getClientDailyGatewaySpend(clientId2, day).toFixed(6));
  const expectedAfterReserve = Number((seedOk + estimate).toFixed(6));
  assert(storedAfterReserve === expectedAfterReserve, `Expected stored spend ${expectedAfterReserve}, got ${storedAfterReserve}`);

  // Case 3: settle(estimate, actual 0.01) -> updates store
  const actual = 0.01;
  settleGatewayBudget(store, clientId2, estimate, actual, day);
  const storedAfterSettle = Number(store.getClientDailyGatewaySpend(clientId2, day).toFixed(6));
  const expectedAfterSettle = Number((seedOk + actual).toFixed(6));
  assert(storedAfterSettle === expectedAfterSettle, `Expected stored spend ${expectedAfterSettle}, got ${storedAfterSettle}`);

  // Case 4: fresh reserve and settle(estimate, 0) -> net 0 change
  const clientId3 = `eval-gw-cancel-${Date.now()}`;
  const initSpend = Number(store.getClientDailyGatewaySpend(clientId3, day).toFixed(6));
  const res3 = reserveGatewayBudget(store, clientId3, estimate);
  assert(res3.ok, "Expected reserve to succeed");
  settleGatewayBudget(store, clientId3, estimate, 0, day);
  const finalSpend = Number(store.getClientDailyGatewaySpend(clientId3, day).toFixed(6));
  assert(finalSpend === initSpend, `Expected net 0 change after settle(estimate, 0), got ${finalSpend} vs initial ${initSpend}`);

  // Case 5: simulate concurrency: call reserve 50 times synchronously from spend 0 with estimate
  const clientIdConc = `eval-gw-conc-${Date.now()}`;
  const maxAllowed = Math.floor(ceiling / estimate);
  let successCount = 0;
  for (let i = 0; i < 50; i++) {
    const r = reserveGatewayBudget(store, clientIdConc, estimate);
    if (r.ok) successCount++;
  }
  assert(successCount === maxAllowed, `Expected exactly ${maxAllowed} successful reservations, got ${successCount}`);
  const concStored = Number(store.getClientDailyGatewaySpend(clientIdConc, day).toFixed(6));
  assert(concStored <= ceiling, `Expected concStored (${concStored}) <= ceiling (${ceiling})`);
}

export async function verifyOfflineMockComplete(): Promise<void> {
  const { createProviderForStage } = await import("../../../model/index.js");
  const { runModelJudgeEvals } = await import("../modelJudge.js");
  const { config } = await import("../../../config.js");
  const { ModelProviderError } = await import("../../../runtime/errors.js");

  // 1. Completion provider in mock mode returns deterministic fixture for exact purposes
  const provider = createProviderForStage("complete");
  const resDefault = await provider.generate({
    system: "Test system",
    messages: [{ role: "user", content: "Test prompt" }],
  });
  assert(resDefault.text.length > 0, "Mock provider did not return text for complete stage.");
  assert(resDefault.provider === "mock", "Provider was not mock.");

  const resGateway = await provider.generate({
    purpose: "gateway_completion",
    messages: [{ role: "user", content: "Test prompt" }],
  });
  assert(resGateway.text.length > 0, "Mock provider did not return text for gateway_completion.");

  // 2. Mock provider fails closed on missing or unmatched fixture entry
  let unmatchedThrew = false;
  try {
    await provider.generate({
      purpose: "non_existent_unmatched_purpose",
      messages: [{ role: "user", content: "Should throw" }],
    });
  } catch (err) {
    if (err instanceof ModelProviderError) {
      unmatchedThrew = true;
    }
  }
  assert(unmatchedThrew, "Mock provider must fail closed with ModelProviderError on unmatched fixture.");

  // 3. Live judge evals are skipped offline by default
  const judgeResults = await runModelJudgeEvals([]);
  assert(judgeResults.length > 0, "runModelJudgeEvals returned empty results.");
  assert(
    judgeResults.every((r) => r.skipped && r.passed),
    "Live model judge was not skipped offline by default.",
  );

  // 4. When live judging is enabled, missing credentials or judge failure fails closed
  const origRunLive = config.runLiveJudge;
  const origGeminiKey = config.geminiApiKey;
  const origProvider = config.provider;
  try {
    (config as Record<string, unknown>).runLiveJudge = true;
    (config as Record<string, unknown>).geminiApiKey = "";
    (config as Record<string, unknown>).provider = "gemini";
    const enabledResults = await runModelJudgeEvals([]);
    assert(enabledResults.length > 0, "Enabled model judge returned empty results.");
    const failedGate = enabledResults[0]!;
    assert(
      !failedGate.passed && !failedGate.skipped,
      `Enabled live judge must fail gate when unconfigured, got passed=${failedGate.passed}, skipped=${failedGate.skipped}`,
    );
  } finally {
    (config as Record<string, unknown>).runLiveJudge = origRunLive;
    (config as Record<string, unknown>).geminiApiKey = origGeminiKey;
    (config as Record<string, unknown>).provider = origProvider;
  }
}

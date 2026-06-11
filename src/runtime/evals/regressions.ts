import { readFileSync } from "node:fs";

import { Agent } from "../../agent.js";
import { intakePublicDefinition } from "../../agents/intakePublic.js";
import { supportAgentDefinition } from "../../agents/supportDefinition.js";
import { createSupportReentrant } from "../../agents/support/reentrant.js";
import { AuditLogger } from "../../audit.js";
import { config, type GeminiModelId } from "../../config.js";
import type {
  GenerateOptions,
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ToolCall,
} from "../../model/provider.js";
import { GeminiProvider } from "../../model/gemini.js";
import { createProject } from "../../pipeline/orchestrator.js";
import { JsonProjectStore } from "../../pipeline/store.js";
import type { StageContext } from "../../pipeline/types.js";
import { createServer } from "../../server/app.js";
import { readAuditEntries } from "../../server/events.js";
import { runIntakeReentrant } from "../../pipeline/stages/intake.js";
import {
  intakeBudgetAuditRunId,
  intakeBudgetDayUtc,
} from "../intakeBudget.js";
import { RuleBasedPolicy, type PolicyConfig } from "../../policy.js";
import type { AnyTool, Policy } from "../../types.js";
import type { StageEvalResult } from "./report.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readAuditJsonl(runId: string): Array<Record<string, unknown>> {
  return readFileSync(`${config.auditDir}/${runId}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const usage: ModelUsage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  thinkingTokens: 0,
  totalTokens: 2,
  groundedPrompts: 0,
};

function result(
  text: string,
  toolCalls: ToolCall[] = [],
  modelId: GeminiModelId = "gemini-2.5-flash",
): ModelResult {
  const content = toolCalls.length
    ? toolCalls.map((call) => ({
        type: "functionCall" as const,
        id: call.id,
        name: call.name,
        args: call.args,
      }))
    : text;
  return {
    provider: "mock",
    modelId,
    text,
    message: { role: "model", content },
    toolCalls,
    citations: [],
    usage,
    costUsd: 0,
    latencyMs: 0,
  };
}

class SequenceProvider implements ModelProvider {
  readonly id: GeminiModelId = "gemini-2.5-flash";
  private index = 0;
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly results: ModelResult[]) {}

  async generate(opts: GenerateOptions): Promise<ModelResult> {
    this.requests.push(opts);
    const next = this.results[this.index++];
    if (!next) throw new Error("SequenceProvider had no remaining result.");
    return next;
  }
}

function deniedPolicy(): Policy {
  const cfg: PolicyConfig = {
    byRisk: { read: "allow", write: "ask", sensitive: "ask" },
    denyWhen: [
      {
        tool: "lookup",
        predicate: (_tool, input) =>
          typeof input === "object" &&
          input !== null &&
          "blocked" in input &&
          input.blocked === true,
        reason: "Blocked lookup argument.",
      },
      {
        tool: "search_knowledge_base",
        predicate: (_tool, input) =>
          typeof input === "object" &&
          input !== null &&
          "query" in input &&
          input.query === "blocked",
        reason: "Blocked support query.",
      },
    ],
  };
  return new RuleBasedPolicy(cfg);
}

async function verifyAgentPolicyArgs(): Promise<void> {
  let ran = false;
  const lookupTool: AnyTool = {
    name: "lookup",
    description: "Lookup test data.",
    inputSchema: { type: "object" },
    risk: "read",
    run: () => {
      ran = true;
      return { content: "tool ran" };
    },
  };
  const agent = new Agent({
    spec: {
      name: "policy-regression",
      systemPrompt: "Use tools only when needed.",
      tools: [lookupTool],
    },
    provider: new SequenceProvider([
      result("", [{ id: "call-1", name: "lookup", args: { blocked: true } }]),
      result("done"),
    ]),
    policy: deniedPolicy(),
  });
  const run = await agent.run("please lookup the blocked record");
  assert(run.finalText === "done", "Agent did not complete after a denied tool call.");
  assert(ran === false, "Agent path ran a tool that policy should have denied.");
}

async function verifyReentrantPolicyArgs(): Promise<void> {
  const project = createProject({
    clientId: "eval",
    title: "Policy regression",
    definition: supportAgentDefinition,
  });
  const stageDefinition = project.agentDefinitionSnapshot.stages[0];
  assert(stageDefinition, "Support definition had no stage.");
  const audit = new AuditLogger(project.id, config.auditDir);
  const ctx: StageContext = {
    project,
    stageId: "support",
    stageDefinition,
    audit,
    provider: new SequenceProvider([
      result("", [
        {
          id: "support-call-1",
          name: "search_knowledge_base",
          args: { query: "blocked" },
        },
      ]),
      result("done"),
    ]),
    io: { say: () => undefined, ask: async () => "unused" },
    store: new JsonProjectStore(),
  };

  const runner = createSupportReentrant(deniedPolicy());
  const start = await runner.start(ctx);
  assert(start.status === "awaiting_input", "Support runner did not request initial input.");
  const finished = await runner.resume(ctx, {
    interactionId: start.interaction.id,
    text: "search for the blocked article",
  });
  assert(finished.status === "awaiting_confirmation", "Support runner did not finish.");
  assert(
    audit.entries.some(
      (entry) =>
        entry.type === "policy_decision" &&
        entry.toolName === "search_knowledge_base" &&
        entry.decision === "deny" &&
        entry.reason === "Blocked support query.",
    ),
    "Reentrant path did not deny based on tool arguments.",
  );
  assert(
    !audit.entries.some(
      (entry) => entry.type === "tool_result" && entry.toolName === "search_knowledge_base",
    ),
    "Reentrant path ran a tool that policy should have denied.",
  );
}

function verifyDefaultPolicyBehavior(): void {
  const readTool: AnyTool = {
    name: "read",
    description: "Read.",
    inputSchema: {},
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const writeTool: AnyTool = { ...readTool, name: "write", risk: "write" };
  const sensitiveTool: AnyTool = { ...readTool, name: "sensitive", risk: "sensitive" };
  const policy = new RuleBasedPolicy();
  assert(policy.decide(readTool, {}).decision === "allow", "Default read policy changed.");
  assert(policy.decide(writeTool, {}).decision === "ask", "Default write policy changed.");
  assert(
    policy.decide(sensitiveTool, {}).decision === "ask",
    "Default sensitive policy changed.",
  );
}

async function verifyRejectRoutePersistsReason(): Promise<void> {
  const token = "reject-regression-token";
  const clientId = `eval-reject-${Date.now()}`;
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const app = createServer({ loopbackToken: token, clientId, store });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "planning-pipeline",
        title: "Reject regression",
      },
    });
    assert(created.statusCode === 200, `Run create failed: ${created.body}`);
    const runId = created.json().run.id as string;

    const project = store.loadProject(clientId, runId);
    assert(project, "Project was not found in store.");
    const stage = project.stages.intake;
    assert(stage, "Intake stage was not found on project.");
    stage.status = "awaiting_confirmation";
    store.saveProject(project);

    const reason = "Missing target customer evidence.";

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/reject`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { reason },
    });
    assert(rejected.statusCode === 200, `Run reject failed: ${rejected.body}`);
    assert(
      rejected.json().run.stages.intake.rejectionReason === reason,
      "Reject response did not include the persisted stage reason.",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: auth,
    });
    assert(detail.statusCode === 200, `Run detail failed: ${detail.body}`);
    assert(
      detail.json().run.stages.intake.status === "rejected" &&
        detail.json().run.stages.intake.rejectionReason === reason,
      "Reloaded run did not preserve rejection status and reason.",
    );

    const audit = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/audit`,
      headers: auth,
    });
    assert(audit.statusCode === 200, `Audit read failed: ${audit.body}`);
    const items = audit.json().items as Array<Record<string, unknown>>;
    assert(
      items.some(
        (entry) =>
          entry.type === "stage_gate" &&
          entry.status === "rejected" &&
          entry.stage === "intake" &&
          entry.reason === reason,
      ),
      "Audit log did not record the rejection reason.",
    );
  } finally {
    await app.close();
  }
}

async function verifyAgentThinkingBudget(): Promise<void> {
  const tool: AnyTool = {
    name: "noop",
    description: "No-op.",
    inputSchema: {},
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const defaultProvider = new SequenceProvider([result("done")]);
  const defaultAgent = new Agent({
    spec: {
      name: "thinking-budget-default",
      systemPrompt: "Answer directly.",
      tools: [tool],
    },
    provider: defaultProvider,
  });
  await defaultAgent.run("hello");
  assert(
    defaultProvider.requests[0]?.thinkingBudget === config.thinkingBudget,
    "Agent did not send the configured finite thinking budget.",
  );

  const unlimitedProvider = new SequenceProvider([result("done")]);
  const unlimitedAgent = new Agent({
    spec: {
      name: "thinking-budget-unlimited",
      systemPrompt: "Answer directly.",
      tools: [tool],
    },
    provider: unlimitedProvider,
    thinkingBudget: -1,
  });
  await unlimitedAgent.run("hello");
  assert(
    unlimitedProvider.requests[0]?.thinkingBudget === -1,
    "Agent did not preserve an explicit unlimited thinking budget.",
  );
}

async function verifyAgentOutputCap(): Promise<void> {
  const tool: AnyTool = {
    name: "noop",
    description: "No-op.",
    inputSchema: {},
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const specProvider = new SequenceProvider([result("done")]);
  const specAgent = new Agent({
    spec: {
      name: "output-cap-spec",
      systemPrompt: "Answer directly.",
      maxOutputTokens: 1234,
      tools: [tool],
    },
    provider: specProvider,
  });
  await specAgent.run("hello");
  assert(
    specProvider.requests[0]?.maxOutputTokens === 1234,
    "Agent did not use the spec output cap.",
  );

  const optionProvider = new SequenceProvider([result("done")]);
  const optionAgent = new Agent({
    spec: {
      name: "output-cap-option",
      systemPrompt: "Answer directly.",
      maxOutputTokens: 1234,
      tools: [tool],
    },
    provider: optionProvider,
    maxOutputTokens: 567,
  });
  await optionAgent.run("hello");
  assert(
    optionProvider.requests[0]?.maxOutputTokens === 567,
    "Agent option output cap did not override the spec cap.",
  );
}

async function verifyAgentSystemPromptCache(): Promise<void> {
  const tool: AnyTool = {
    name: "noop",
    description: "No-op.",
    inputSchema: {},
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const provider = new SequenceProvider([
    result("", [{ id: "noop-1", name: "noop", args: {} }]),
    result("done"),
  ]);
  const systemPrompt = "Stable system instruction. ".repeat(600);
  const agent = new Agent({
    spec: {
      name: "cache-regression",
      systemPrompt,
      tools: [tool],
    },
    provider,
  });
  await agent.run("please use the no-op");
  assert(provider.requests.length === 2, "Agent cache regression did not force two turns.");
  const first = provider.requests[0];
  const second = provider.requests[1];
  assert(first?.cacheKey && first.cacheKey === second?.cacheKey, "Agent cache key was not stable.");
  assert(
    first.cacheSystem === systemPrompt && second?.cacheSystem === systemPrompt,
    "Agent did not send the stable system prompt as cacheSystem.",
  );
  assert(
    first.cacheFallbackMessages === false && second.cacheFallbackMessages === false,
    "Agent cache fallback would mutate messages.",
  );
  assert(
    second.messages.every(
      (message) =>
        typeof message.content !== "string" ||
        !message.content.includes("Stable system instruction."),
    ),
    "Agent cache prompt leaked into conversational messages.",
  );
}

async function verifyAuditRedactionAndTruncation(): Promise<void> {
  const secretTool: AnyTool = {
    name: "secret_tool",
    description: "Uses secret-looking inputs.",
    inputSchema: { type: "object" },
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const agent = new Agent({
    spec: {
      name: "audit-redaction",
      systemPrompt: "Call the tool once.",
      tools: [secretTool],
    },
    provider: new SequenceProvider([
      result("", [
        {
          id: "secret-call",
          name: "secret_tool",
          args: {
            password: "p@ssword",
            apiKey: "jantra-secret",
            normal: "visible",
          },
        },
      ]),
      result("done"),
    ]),
  });
  const run = await agent.run("use the secret tool");
  const toolCall = readAuditJsonl(run.runId).find(
    (entry) => entry.type === "tool_call" && entry.toolName === "secret_tool",
  );
  assert(toolCall, "Tool call audit entry was not written.");
  const input = toolCall.input as Record<string, unknown>;
  assert(
    input.password === "[redacted]" &&
      input.apiKey === "[redacted]" &&
      input.normal === "visible",
    "Tool-call input secrets were not redacted shallowly.",
  );

  const audit = new AuditLogger(`audit-truncation-${Date.now()}`, config.auditDir);
  audit.record("tool_result", {
    toolName: "large_tool",
    content: "x".repeat(config.auditMaxFieldBytes * 4),
  });
  const [entry] = readAuditJsonl(audit.runId);
  assert(entry, "Large audit entry was not written.");
  const content = entry.content;
  assert(typeof content === "string", "Large audit content did not serialize as a string.");
  assert(content.includes("[truncated"), "Large audit content did not include a truncation marker.");
  assert(
    Buffer.byteLength(content, "utf8") <= config.auditMaxFieldBytes,
    "Large audit field exceeded the configured field cap.",
  );
}

async function verifyUserMessageLengthGuard(): Promise<void> {
  const tool: AnyTool = {
    name: "noop",
    description: "No-op.",
    inputSchema: {},
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const blockedProvider = new SequenceProvider([result("should not run")]);
  const blockedAgent = new Agent({
    spec: {
      name: "message-length-blocked",
      systemPrompt: "Answer directly.",
      tools: [tool],
    },
    provider: blockedProvider,
  });
  let blocked = false;
  try {
    await blockedAgent.run("x".repeat(config.maxUserMessageChars + 1));
  } catch (err) {
    blocked =
      err instanceof Error &&
      "code" in err &&
      err.code === "guardrail_blocked";
  }
  assert(blocked, "Over-length user message was not rejected loudly.");
  assert(blockedProvider.requests.length === 0, "Provider was called for over-length message.");

  const allowedProvider = new SequenceProvider([result("done")]);
  const allowedAgent = new Agent({
    spec: {
      name: "message-length-allowed",
      systemPrompt: "Answer directly.",
      tools: [tool],
    },
    provider: allowedProvider,
  });
  const run = await allowedAgent.run("normal message");
  assert(run.finalText === "done", "Normal user message was affected by the length guard.");
}

async function verifyGeminiCacheDispose(): Promise<void> {
  const deleted: string[] = [];
  const provider = Object.create(GeminiProvider.prototype) as {
    dispose: () => Promise<void>;
    cacheHandles: Map<string, string>;
    ai: { caches: { delete: (params: { name: string }) => Promise<void> } };
  };
  provider.cacheHandles = new Map([
    ["first", "cachedContents/first"],
    ["second", "cachedContents/second"],
  ]);
  provider.ai = {
    caches: {
      delete: async ({ name }) => {
        deleted.push(name);
        if (name.endsWith("second")) throw new Error("delete failed");
      },
    },
  };

  await provider.dispose();
  assert(
    deleted.includes("cachedContents/first") && deleted.includes("cachedContents/second"),
    "Gemini cache dispose did not attempt every tracked delete.",
  );
  assert(provider.cacheHandles.size === 0, "Gemini cache handles were not cleared.");
}

async function verifyHandoffSkippedToolAudit(): Promise<void> {
  let skippedRuns = 0;
  const handoffTool: AnyTool = {
    name: "handoff_tool",
    description: "Hands off.",
    inputSchema: {},
    risk: "read",
    run: (_input, ctx) => {
      ctx.requestHandoff("needs_human", "Stop and hand off.");
      return { content: "handoff requested" };
    },
  };
  const skippedTool: AnyTool = {
    name: "skipped_tool",
    description: "Should be skipped.",
    inputSchema: {},
    risk: "read",
    run: () => {
      skippedRuns++;
      return { content: "should not run" };
    },
  };
  const agent = new Agent({
    spec: {
      name: "handoff-skip-regression",
      systemPrompt: "Use the tools.",
      tools: [handoffTool, skippedTool],
    },
    provider: new SequenceProvider([
      result("", [
        { id: "handoff", name: "handoff_tool", args: {} },
        { id: "skip-1", name: "skipped_tool", args: { n: 1 } },
        { id: "skip-2", name: "skipped_tool", args: { n: 2 } },
      ]),
    ]),
  });
  const run = await agent.run("trigger handoff");
  assert(run.handedOff, "Agent did not hand off.");
  assert(skippedRuns === 0, "Skipped tools ran after handoff.");
  const skipped = readAuditJsonl(run.runId).filter(
    (entry) =>
      entry.type === "tool_call" &&
      entry.toolName === "skipped_tool" &&
      entry.skipped === true &&
      entry.reason === "handoff",
  );
  assert(skipped.length === 2, "Skipped handoff tool calls were not audited.");
}

async function verifyClientDailyIdeationBudget(): Promise<void> {
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

async function verifyIntakeSessionBudget(): Promise<void> {
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

async function runRegression(
  fixtureId: string,
  fn: () => Promise<void> | void,
): Promise<StageEvalResult> {
  try {
    await fn();
    return {
      fixtureId,
      stage: "regression",
      score: 5,
      passed: true,
      notes: "Regression check passed.",
    };
  } catch (err) {
    return {
      fixtureId,
      stage: "regression",
      score: 1,
      passed: false,
      notes: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runRegressionEvals(): Promise<StageEvalResult[]> {
  return [
    await runRegression("policy-defaults", verifyDefaultPolicyBehavior),
    await runRegression("policy-agent-args", verifyAgentPolicyArgs),
    await runRegression("policy-reentrant-args", verifyReentrantPolicyArgs),
    await runRegression("reject-route-reason", verifyRejectRoutePersistsReason),
    await runRegression("agent-thinking-budget", verifyAgentThinkingBudget),
    await runRegression("agent-output-cap", verifyAgentOutputCap),
    await runRegression("agent-system-cache", verifyAgentSystemPromptCache),
    await runRegression("audit-redaction-truncation", verifyAuditRedactionAndTruncation),
    await runRegression("user-message-length", verifyUserMessageLengthGuard),
    await runRegression("gemini-cache-dispose", verifyGeminiCacheDispose),
    await runRegression("handoff-skipped-tools", verifyHandoffSkippedToolAudit),
    await runRegression("intake-client-daily-budget", verifyClientDailyIdeationBudget),
    await runRegression("intake-session-budget", verifyIntakeSessionBudget),
  ];
}

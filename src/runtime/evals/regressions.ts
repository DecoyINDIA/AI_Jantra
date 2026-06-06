import { Agent } from "../../agent.js";
import { supportAgentDefinition } from "../../agents/supportDefinition.js";
import { createSupportReentrant } from "../../agents/support/reentrant.js";
import { AuditLogger } from "../../audit.js";
import { config, type GeminiModelId } from "../../config.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ToolCall,
} from "../../model/provider.js";
import { createProject } from "../../pipeline/orchestrator.js";
import type { StageContext } from "../../pipeline/types.js";
import { createServer } from "../../server/app.js";
import { RuleBasedPolicy, type PolicyConfig } from "../../policy.js";
import type { AnyTool, Policy } from "../../types.js";
import type { StageEvalResult } from "./report.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

  constructor(private readonly results: ModelResult[]) {}

  async generate(): Promise<ModelResult> {
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
  const app = createServer({ loopbackToken: token, clientId });
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
  ];
}

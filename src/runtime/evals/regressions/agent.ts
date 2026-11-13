import { Agent } from "../../../agent.js";
import { config } from "../../../config.js";
import { GeminiProvider } from "../../../model/gemini.js";
import { shouldRejectUnknownCost } from "../../../model/openaiCompatible.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { createStageExecutionState } from "../../../pipeline/executionState.js";
import { checkpointResearchState } from "../../../pipeline/stages/research.js";
import { JsonProjectStore, type ProjectStore } from "../../../pipeline/store.js";
import type { Artifact, Project, ProjectListQuery, ProjectPage, Source, StageContext } from "../../../pipeline/types.js";
import type { AnyTool } from "../../../types.js";
import { assert, readAuditJsonl, result, SequenceProvider } from "./common.js";

export async function verifyAgentThinkingBudget(): Promise<void> {
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

export async function verifyAgentOutputCap(): Promise<void> {
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

export async function verifyAgentSystemPromptCache(): Promise<void> {
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

export async function verifyGeminiCacheDispose(): Promise<void> {
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

export async function verifyHandoffSkippedToolAudit(): Promise<void> {
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

export async function verifyUserMessageLengthGuard(): Promise<void> {
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

class CountingProjectStore implements ProjectStore {
  saves = 0;
  constructor(private readonly base: ProjectStore) {}

  saveProject(project: Project): void {
    this.saves++;
    this.base.saveProject(project);
  }

  loadProject(clientId: string, projectId: string): Project | null {
    return this.base.loadProject(clientId, projectId);
  }

  listProjects(query: ProjectListQuery): ProjectPage {
    return this.base.listProjects(query);
  }

  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number {
    return this.base.getClientDailyIdeationSpend(clientId, dayUtc);
  }

  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    this.base.addClientDailyIdeationSpend(clientId, dayUtc, deltaUsd);
  }

  getClientDailyGatewaySpend(clientId: string, dayUtc: string): number {
    return this.base.getClientDailyGatewaySpend(clientId, dayUtc);
  }

  addClientDailyGatewaySpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    this.base.addClientDailyGatewaySpend(clientId, dayUtc, deltaUsd);
  }

  writeArtifactFile(clientId: string, projectId: string, artifact: Artifact): string {
    return this.base.writeArtifactFile(clientId, projectId, artifact);
  }

  writeSourceContentFile(
    clientId: string,
    projectId: string,
    source: Source,
    content: string,
  ): string {
    return this.base.writeSourceContentFile(clientId, projectId, source, content);
  }
}

export function verifyResearchCheckpointPersisted(): void {
  const base = new JsonProjectStore();
  const store = new CountingProjectStore(base);
  const clientId = `test-client-${Date.now()}`;
  const project = createProject({
    clientId,
    title: "T-010 Checkpoint Project",
    agentId: "planning-pipeline",
  });
  base.saveProject(project);

  const state = createStageExecutionState("research", "planning.research", {
    plan: { x: 1 },
  });

  const ctx = {
    project,
    stageId: "research",
    store,
  } as unknown as StageContext;

  checkpointResearchState(ctx, state);

  assert(store.saves === 1, `Expected exactly 1 save, got ${store.saves}`);
  const loaded = base.loadProject(project.clientId, project.id);
  assert(loaded !== null, "Failed to load project from base store");
  const planData = (loaded.execution as any)?.research?.data?.plan as { x?: number } | undefined;
  assert(planData?.x === 1, `Expected plan.x === 1, got ${JSON.stringify(planData)}`);
}

export function verifyUnknownModelCost(): void {
  // reported cost present (even when 0) → false
  assert(!shouldRejectUnknownCost({ reportedCost: 0, priceIn: 0, priceOut: 0, allowUnpriced: false, totalTokens: 100 }), "reportedCost=0 should not reject");
  assert(!shouldRejectUnknownCost({ reportedCost: 0.05, priceIn: 0, priceOut: 0, allowUnpriced: false, totalTokens: 100 }), "reportedCost>0 should not reject");

  // prices set → false
  assert(!shouldRejectUnknownCost({ reportedCost: undefined, priceIn: 1, priceOut: 0, allowUnpriced: false, totalTokens: 100 }), "priceIn>0 should not reject");
  assert(!shouldRejectUnknownCost({ reportedCost: undefined, priceIn: 0, priceOut: 2, allowUnpriced: false, totalTokens: 100 }), "priceOut>0 should not reject");

  // allow flag → false
  assert(!shouldRejectUnknownCost({ reportedCost: undefined, priceIn: 0, priceOut: 0, allowUnpriced: true, totalTokens: 100 }), "allowUnpriced=true should not reject");

  // zero tokens → false
  assert(!shouldRejectUnknownCost({ reportedCost: undefined, priceIn: 0, priceOut: 0, allowUnpriced: false, totalTokens: 0 }), "totalTokens=0 should not reject");

  // otherwise → true
  assert(shouldRejectUnknownCost({ reportedCost: undefined, priceIn: 0, priceOut: 0, allowUnpriced: false, totalTokens: 100 }), "unpriced non-zero tokens should reject");
}

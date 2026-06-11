import { Agent } from "../agent.js";
import { consoleHandoff } from "../handoff.js";
import { RuleBasedPolicy } from "../policy.js";
import { StageFailedClosedError } from "../runtime/errors.js";
import type { Artifact, StageRunner } from "../pipeline/types.js";
import type { ReentrantStageRunner } from "../pipeline/reentrant.js";
import { runIntake, runIntakeReentrant } from "../pipeline/stages/intake.js";
import { runPlanning } from "../pipeline/stages/planning.js";
import { runResearch } from "../pipeline/stages/research.js";
import { supportAgentSpec } from "./support/index.js";
import { runSupportReentrant } from "./support/reentrant.js";
import {
  runOpsProfileReentrant,
  runOpsKpiDesign,
  runOpsSourceBindingReentrant,
} from "../pipeline/stages/opsOnboarding.js";
import {
  runOpsIngest,
  runOpsAnalyze,
  runOpsCompose,
  runOpsDeliver,
} from "../pipeline/stages/opsReporting.js";

async function disabledBuild(): Promise<Artifact[]> {
  throw new StageFailedClosedError("Build stage is disabled and out of scope.");
}

const supportToolLoop: StageRunner = async (ctx) => {
  ctx.io.say("Tell me the support request to handle.");
  const request = await ctx.io.ask("support request");
  const agent = new Agent({
    spec: supportAgentSpec,
    provider: ctx.provider,
    policy: new RuleBasedPolicy(),
    onApproval: async (approval) => {
      ctx.io.say(
        `Approval needed for ${approval.toolName}: ${JSON.stringify(approval.input)}`,
      );
      const answer = (await ctx.io.ask("approve? [y/N]")).toLowerCase();
      return answer === "y" || answer === "yes";
    },
    onHandoff: consoleHandoff,
  });
  const result = await agent.run(request);
  return [
    {
      stage: ctx.stageId,
      kind: "support_summary",
      title: "Support run summary",
      content: `# Support run summary

Final response:
${result.finalText ?? "(none)"}

Handed off: ${result.handedOff ? "yes" : "no"}
Steps: ${result.steps}
Cost: $${result.usage.costUsd.toFixed(4)}
`,
      version: 1,
      createdAt: new Date().toISOString(),
    },
  ];
};

const RUNNERS = new Map<string, StageRunner>([
  ["planning.intake", runIntake],
  ["planning.research", runResearch],
  ["planning.planning", runPlanning],
  ["disabled.build", disabledBuild],
  ["support.toolLoop", supportToolLoop],
  ["ops.kpiDesign", runOpsKpiDesign],
  ["ops.ingest", runOpsIngest],
  ["ops.analyze", runOpsAnalyze],
  ["ops.compose", runOpsCompose],
  ["ops.deliver", runOpsDeliver],
]);

const REENTRANT_RUNNERS = new Map<string, ReentrantStageRunner>([
  ["planning.intake", runIntakeReentrant],
  ["support.toolLoop", runSupportReentrant],
  ["ops.profile", runOpsProfileReentrant],
  ["ops.sourceBinding", runOpsSourceBindingReentrant],
]);

export function getStageRunner(kind: string): StageRunner {
  const runner = RUNNERS.get(kind);
  if (!runner) {
    throw new StageFailedClosedError(`No stage runner registered for ${kind}.`);
  }
  return runner;
}

export function getReentrantStageRunner(kind: string): ReentrantStageRunner {
  const runner = REENTRANT_RUNNERS.get(kind);
  if (!runner) {
    throw new StageFailedClosedError(`No reentrant stage runner registered for ${kind}.`);
  }
  return runner;
}

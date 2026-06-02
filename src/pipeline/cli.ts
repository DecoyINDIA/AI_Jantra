import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import Anthropic from "@anthropic-ai/sdk";

import { requireApiKey } from "../config.js";
import { createProject, runStage, stageTitle } from "./orchestrator.js";
import type { StageIO } from "./types.js";

/**
 * Runs the onboarding pipeline from the terminal. Currently builds Stage 1
 * (Intake) end to end and stops at the first confirmation gate. Stages 2-4
 * land in later increments (see docs/PIPELINE.md).
 */
async function main() {
  requireApiKey();

  const clientId = "xolver"; // single-tenant for now
  const rl = createInterface({ input: stdin, output: stdout });

  const io: StageIO = {
    say: (message) => console.log(message),
    ask: async (question) => (await rl.question(`${question} > `)).trim(),
  };

  console.log("\nJantra AI — onboarding pipeline");
  console.log(`client: ${clientId}\n`);

  const project = createProject(clientId, "Untitled idea");
  console.log(`project: ${project.id}`);
  console.log(`stage:   ${stageTitle(project.currentStage)}\n`);

  const client = new Anthropic();
  const artifacts = await runStage(project, io, client);

  console.log("\n———  STAGE ARTIFACT(S)  ———");
  for (const a of artifacts) {
    console.log(`\n[${a.kind}] ${a.title}\n`);
    console.log(a.content);
  }

  console.log("———  GATE  ———");
  console.log(
    `Stage "${stageTitle(project.currentStage)}" is awaiting your confirmation.`,
  );
  console.log(
    `Saved to .jantra/projects/${clientId}/${project.id}/ and audited at ` +
      `.jantra/audit/${project.id}.jsonl`,
  );
  console.log(
    "\nNext increment wires Stage 2 (Research) behind this gate. For now the pipeline stops here.",
  );

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nPipeline run failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

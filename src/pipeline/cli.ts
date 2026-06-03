import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { defaultAgentRegistry } from "../agents/registry.js";
import { requireApiKey } from "../config.js";
import { confirmStage, createProject, runStage, stageTitle } from "./orchestrator.js";
import type { StageIO } from "./types.js";

async function main() {
  requireApiKey();

  const args = process.argv.slice(2);
  const autoConfirm = args.includes("--auto-confirm");
  const clientId = "xolver";
  const rl = createInterface({ input: stdin, output: stdout });

  const io: StageIO = {
    say: (message) => console.log(message),
    ask: async (question) => (await rl.question(`${question} > `)).trim(),
  };

  console.log("\nJantra AI - onboarding pipeline");
  console.log(`client: ${clientId}\n`);

  const definition = defaultAgentRegistry.get("planning-pipeline");
  const project = createProject({ clientId, title: "Untitled idea", definition });
  console.log(`project: ${project.id}`);

  while (project.status === "active") {
    console.log(`stage:   ${stageTitle(project.currentStage, project.agentDefinitionSnapshot)}\n`);
    const artifacts = await runStage(project, io);

    console.log("\n--- STAGE ARTIFACT(S) ---");
    for (const artifact of artifacts) {
      console.log(`\n[${artifact.kind}] ${artifact.title}\n`);
      console.log(artifact.content);
    }

    console.log("--- GATE ---");
    console.log(
      `Stage "${stageTitle(
        project.currentStage,
        project.agentDefinitionSnapshot,
      )}" is awaiting confirmation.`,
    );
    const confirmed =
      autoConfirm ||
      (await rl.question("confirm this stage and continue? [y/N] ")).trim().toLowerCase() ===
        "y";
    if (!confirmed) {
      console.log("Stage not confirmed. The project remains awaiting review.");
      break;
    }
    const next = confirmStage(project);
    if (!next) {
      console.log("\nPipeline completed. Build stage remains disabled and out of scope.");
      break;
    }
  }

  console.log(
    `\nSaved to .jantra/projects/${clientId}/${project.id}/ and audited at ` +
      `.jantra/audit/${project.id}.jsonl`,
  );
  console.log(`Cost: $${project.cost.usd.toFixed(4)}`);
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nPipeline run failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

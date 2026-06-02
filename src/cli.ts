import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { Agent } from "./agent.js";
import { requireApiKey } from "./config.js";
import { consoleHandoff } from "./handoff.js";
import { RuleBasedPolicy } from "./policy.js";
import { supportAgentSpec } from "./agents/support/index.js";
import type { ApprovalHandler } from "./types.js";

/**
 * Approval gate for the demo. In production this is a UI, a Slack approval, or a
 * helpdesk action. Here: ask on the terminal, or auto-approve / fail-closed.
 */
function buildApprovalHandler(autoApprove: boolean): ApprovalHandler {
  if (autoApprove) {
    return async (req) => {
      console.log(`\n[auto-approve] ${req.toolName} ${JSON.stringify(req.input)}`);
      return true;
    };
  }
  if (!stdin.isTTY) {
    // No interactive terminal: deny rather than silently act.
    return async (req) => {
      console.log(`\n[no TTY — denying] ${req.toolName} ${JSON.stringify(req.input)}`);
      return false;
    };
  }
  const rl = createInterface({ input: stdin, output: stdout });
  return async (req) => {
    console.log(`\n———  APPROVAL NEEDED  ———`);
    console.log(`tool:   ${req.toolName}`);
    console.log(`reason: ${req.reason}`);
    console.log(`input:  ${JSON.stringify(req.input, null, 2)}`);
    const answer = (await rl.question("approve? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

async function main() {
  requireApiKey();

  const args = process.argv.slice(2);
  const autoApprove = args.includes("--auto-approve");
  const message =
    args.filter((a) => !a.startsWith("--")).join(" ").trim() ||
    "Hi, my desk lamp on order A-1001 arrived with a cracked base. I'd like a refund. My email is dana@example.com.";

  console.log(`\nMainframe — ${supportAgentSpec.name}`);
  console.log(`customer: ${message}\n`);

  const agent = new Agent({
    spec: supportAgentSpec,
    policy: new RuleBasedPolicy(),
    onApproval: buildApprovalHandler(autoApprove),
    onHandoff: consoleHandoff,
  });

  const result = await agent.run(message);

  console.log("\n———  RESULT  ———");
  if (result.finalText) console.log(result.finalText);
  console.log(
    `\nsteps: ${result.steps} | handed off: ${result.handedOff} | ` +
      `tokens in/out: ${result.usage.inputTokens}/${result.usage.outputTokens} ` +
      `(cache read: ${result.usage.cacheReadTokens})`,
  );
  console.log(`audit trail: .mainframe/audit/${result.runId}.jsonl`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\nMainframe run failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

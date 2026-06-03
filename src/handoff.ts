import type { HandoffHandler } from "./types.js";

/**
 * Default handoff sink: prints the handoff to the console. In production this is
 * where you page a human, open a ticket, ping Slack, assign in the helpdesk.
 * The agent always stops and hands off with full context rather than guessing.
 */
export const consoleHandoff: HandoffHandler = ({ runId, reason, summary }) => {
  console.log("\n---  HANDOFF TO HUMAN  ---");
  console.log(`run:     ${runId}`);
  console.log(`reason:  ${reason}`);
  console.log(`summary: ${summary}`);
  console.log("--------------------------\n");
};

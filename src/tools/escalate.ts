import type { ToolDef } from "../types.js";

/**
 * Built-in handoff tool. Available to every agent. When the agent is unsure, or
 * judgment is needed, it calls this instead of guessing, and the loop stops.
 */
export const escalateTool: ToolDef<{ reason: string; summary: string }> = {
  name: "escalate_to_human",
  description:
    "Hand the task to a human teammate. Call this when you are unsure, when the request needs judgment you should not make alone, or when a needed action was blocked. Provide a clear reason and a summary of the situation so the person has full context.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short reason for handing off, e.g. 'needs a refund over policy limit'.",
      },
      summary: {
        type: "string",
        description: "What the customer wants, what you found, and what is still open.",
      },
    },
    required: ["reason", "summary"],
    additionalProperties: false,
  },
  run: (input, ctx) => {
    ctx.requestHandoff(input.reason, input.summary);
    return { content: "Handed off to a human. Stop here and wait." };
  },
};

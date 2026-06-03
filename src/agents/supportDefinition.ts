import { supportAgentSpec } from "./support/index.js";
import type { AgentDefinition } from "./definition.js";

export const supportAgentDefinition: AgentDefinition = {
  id: "support-agent",
  name: "Support Agent",
  description:
    "A reference one-stage tool-loop agent for customer support workflows.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "support",
      title: "Support",
      description: "Handles a customer support request with policy-gated tools.",
      kind: "tool-loop",
      runnerKind: "support.toolLoop",
      model: "flash",
      artifactKinds: ["support_summary"],
      gate: "human",
      interactionMode: "reentrant",
      toolNames: supportAgentSpec.tools.map((tool) => tool.name),
    },
  ],
};

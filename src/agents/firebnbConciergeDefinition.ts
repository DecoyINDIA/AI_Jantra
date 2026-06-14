import { firebnbConciergeSpec } from "./firebnb/index.js";
import type { AgentDefinition } from "./definition.js";

export const firebnbConciergeDefinition: AgentDefinition = {
  id: "firebnb-concierge",
  name: "FireBNB Concierge",
  description: "A grounded conversational hotel search concierge agent.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "concierge",
      title: "Concierge",
      description: "Chat with a virtual concierge to find lodging and check current rates.",
      kind: "tool-loop",
      runnerKind: "firebnb.concierge",
      model: "flash",
      artifactKinds: ["conversation_summary"],
      gate: "human",
      interactionMode: "reentrant",
      toolNames: firebnbConciergeSpec.tools.map((tool) => tool.name),
    },
  ],
};

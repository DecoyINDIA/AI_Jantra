import type { AgentDefinition } from "./definition.js";

/**
 * Public, embeddable intake agent.
 *
 * This is the agent the Jantra widget runs on a public marketing site (Xolver
 * being the first consumer). It reuses the planning pipeline's Intake stage
 * runner (`planning.intake` -> runIntakeReentrant) but stops after producing the
 * `idea_summary` artifact: anonymous web visitors never trigger the expensive
 * Research or Planning stages. The human gate parks the run at
 * `awaiting_confirmation` once the summary exists, which is where the widget
 * reads the summary and hands it back to the host as a captured lead.
 */
export const intakePublicDefinition: AgentDefinition = {
  id: "intake-public",
  name: "Jantra Intake",
  description:
    "Conversational intake agent for public embedding. Clarifies a visitor's idea and produces a structured idea summary. Does not advance into research or planning.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "intake",
      title: "Intake",
      description: "Clarifies the visitor's idea and produces a structured idea summary.",
      kind: "model-flow",
      runnerKind: "planning.intake",
      model: "flash",
      artifactKinds: ["idea_summary"],
      gate: "human",
      interactionMode: "reentrant",
    },
  ],
};

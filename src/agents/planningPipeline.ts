import type { AgentDefinition } from "./definition.js";

export const planningPipelineDefinition: AgentDefinition = {
  id: "planning-pipeline",
  name: "Jantra Planning Pipeline",
  description:
    "Turns a raw product idea into a researched, verified, build-ready plan.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "intake",
      title: "Intake",
      description: "Clarifies the raw idea and produces a structured idea summary.",
      kind: "model-flow",
      runnerKind: "planning.intake",
      model: "flash",
      artifactKinds: ["idea_summary"],
      gate: "human",
      interactionMode: "reentrant",
    },
    {
      id: "research",
      title: "Research",
      description:
        "Produces a cited market research report with deterministic citation verification.",
      kind: "model-flow",
      runnerKind: "planning.research",
      model: "flash",
      artifactKinds: ["research_report"],
      gate: "human",
      interactionMode: "none",
    },
    {
      id: "planning",
      title: "Planning",
      description: "Produces the PRD, TRD, and phased build plan.",
      kind: "model-flow",
      runnerKind: "planning.planning",
      model: "pro",
      artifactKinds: ["prd", "trd", "build_plan"],
      gate: "human",
      interactionMode: "none",
    },
    {
      id: "build",
      title: "Build",
      description: "Registered for future expansion. Disabled by design.",
      kind: "disabled",
      runnerKind: "disabled.build",
      model: "flash",
      artifactKinds: [],
      gate: "disabled",
      interactionMode: "none",
      enabled: false,
    },
  ],
};

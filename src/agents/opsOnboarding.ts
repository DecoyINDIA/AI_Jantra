import type { AgentDefinition } from "./definition.js";

export const opsOnboardingDefinition: AgentDefinition = {
  id: "ops-onboarding",
  name: "Ops Onboarding Agent",
  description: "Sets up an SMB business profile, standardizes KPIs, and establishes source bindings.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "profile",
      title: "Business Profile",
      description: "Interviews the owner to build a profile of the business model and event calendar.",
      kind: "model-flow",
      runnerKind: "ops.profile",
      model: "flash",
      artifactKinds: ["business_profile"],
      gate: "human",
      interactionMode: "reentrant",
    },
    {
      id: "kpi-design",
      title: "KPI Design",
      description: "Generates custom and catalog KPIs based on the business profile.",
      kind: "model-flow",
      runnerKind: "ops.kpiDesign",
      model: "flash",
      artifactKinds: ["kpi_spec"],
      gate: "human",
      interactionMode: "none",
    },
    {
      id: "source-binding",
      title: "Source Binding",
      description: "Binds operational data sources and maps fields to the canonical schema.",
      kind: "model-flow",
      runnerKind: "ops.sourceBinding",
      model: "flash",
      artifactKinds: ["source_binding"],
      gate: "human",
      interactionMode: "reentrant",
    },
  ],
};

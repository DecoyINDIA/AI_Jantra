import type { AgentDefinition } from "./definition.js";

export const opsReportingDefinition: AgentDefinition = {
  id: "ops-reporting",
  name: "Ops Reporting Agent",
  description: "Produces verified and anomaly-aware periodic operational reports.",
  version: 1,
  clientScoped: true,
  stages: [
    {
      id: "ingest",
      title: "Data Ingest",
      description: "Pulls operational data and runs the data quality and reconciliation battery.",
      kind: "model-flow",
      runnerKind: "ops.ingest",
      model: "flash",
      artifactKinds: ["data_snapshot", "data_quality_report"],
      gate: "human", // auto-candidate
      interactionMode: "none",
    },
    {
      id: "analyze",
      title: "Data Analysis",
      description: "Computes KPIs using the formula engine and runs seasonal anomaly detection.",
      kind: "model-flow",
      runnerKind: "ops.analyze",
      model: "flash",
      artifactKinds: ["kpi_results", "anomaly_findings"],
      gate: "human", // auto-candidate
      interactionMode: "none",
    },
    {
      id: "compose",
      title: "Report Composition",
      description: "Writes the narrative report, enforcing number-provenance and causality bounds.",
      kind: "model-flow",
      runnerKind: "ops.compose",
      model: "flash", // flash per spec, pro candidate
      artifactKinds: ["ops_report"],
      gate: "human",
      interactionMode: "none",
    },
    {
      id: "deliver",
      title: "Report Delivery",
      description: "Delivers the compiled report to the configured recipients and channels.",
      kind: "model-flow",
      runnerKind: "ops.deliver",
      model: "flash",
      artifactKinds: ["delivery_receipt"],
      gate: "human",
      interactionMode: "none",
    },
    {
      id: "forecast",
      title: "Forecasting",
      description: "Future stage for predictive forecasting. Disabled by design in v1.",
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

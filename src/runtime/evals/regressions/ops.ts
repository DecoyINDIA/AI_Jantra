import * as path from "node:path";
import { opsReportingDefinition } from "../../../agents/opsReporting.js";
import { AuditLogger } from "../../../audit.js";
import { config } from "../../../config.js";
import { resolveClientDataDir } from "../../../pipeline/ops/connectors/csv.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { runOpsDeliver, runOpsIngest, syntheticDataAllowed } from "../../../pipeline/stages/opsReporting.js";
import { JsonProjectStore } from "../../../pipeline/store.js";
import type { StageContext } from "../../../pipeline/types.js";
import { assert, SequenceProvider } from "./common.js";

export function verifyCsvDirectoryResolve(): void {
  // Safe relative subdirectory under <opsDataDir>/acme
  const safe = resolveClientDataDir("acme", "subdir");
  assert(safe === path.resolve(config.opsDataDir, "acme", "subdir"), `Expected resolved safe path to match, got: ${safe}`);

  // Safe empty/default path resolves to <opsDataDir>/acme
  const def = resolveClientDataDir("acme");
  assert(def === path.resolve(config.opsDataDir, "acme"), `Expected resolved default path to match, got: ${def}`);

  // Path traversal attempt should throw an error
  const unsafePaths = [
    "../../etc",
    "../",
    "../../",
    "/absolute/path",
    "C:\\Windows",
  ];
  for (const p of unsafePaths) {
    let threw = false;
    try {
      resolveClientDataDir("acme", p);
    } catch {
      threw = true;
    }
    assert(threw, `resolveClientDataDir did not throw for unsafe path: ${p}`);
  }
}

export async function verifyOpsDeliveryHonest(): Promise<void> {
  const project = createProject({
    clientId: "eval",
    title: "t",
    definition: opsReportingDefinition,
  });
  const composeStage = project.stages["compose"];
  assert(composeStage, "Compose stage missing.");
  composeStage.artifacts.push({
    stage: "compose",
    kind: "ops_report",
    title: "r",
    content: "# r",
    version: 1,
    createdAt: new Date().toISOString(),
  });

  const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "deliver");
  assert(stageDefinition, "Deliver stage definition missing.");
  const audit = new AuditLogger(project.id, config.auditDir);
  const ctx: StageContext = {
    project,
    stageId: "deliver",
    stageDefinition,
    audit,
    provider: new SequenceProvider([]),
    io: { say: () => undefined, ask: async () => "" },
    store: new JsonProjectStore(),
  };

  const artifacts = await runOpsDeliver(ctx);
  assert(artifacts.length === 1, "Expected 1 artifact from runOpsDeliver");
  const receipt = artifacts[0]!;
  assert(receipt.kind === "delivery_receipt", "Expected delivery_receipt artifact");
  assert(receipt.title === "Delivery Receipt (not sent)", "Expected title 'Delivery Receipt (not sent)'");

  const parsed = JSON.parse(receipt.content);
  assert(parsed.status === "not_sent", `Expected status === "not_sent", got ${parsed.status}`);
  assert(parsed.channel === "none", `Expected channel === "none", got ${parsed.channel}`);
  assert(Array.isArray(parsed.recipients) && parsed.recipients.length === 0, "Expected empty recipients array");
  assert(!receipt.content.includes("@"), "Delivery receipt content must not contain email addresses");
}

export async function verifyOpsNoSilentSynthetic(): Promise<void> {
  assert(syntheticDataAllowed("gemini", false) === false, "gemini without opt-in should be false");
  assert(syntheticDataAllowed("openai-compatible", false) === false, "openai-compatible without opt-in should be false");
  assert(syntheticDataAllowed("gemini", true) === true, "gemini with opt-in should be true");

  const project = createProject({
    clientId: "eval",
    title: "t",
    definition: opsReportingDefinition,
  });
  const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "ingest");
  assert(stageDefinition, "Ingest stage definition missing.");

  class MockAuditLogger extends AuditLogger {
    readonly records: Array<{ type: string; data: Record<string, unknown> }> = [];
    override record(type: any, data: Record<string, unknown>): void {
      this.records.push({ type, data });
      super.record(type, data);
    }
  }

  const prevOptIn = config.opsAllowSynthetic;
  try {
    (config as any).opsAllowSynthetic = true;

    const audit = new MockAuditLogger(project.id, config.auditDir);
    const ctx: StageContext = {
      project,
      stageId: "ingest",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store: new JsonProjectStore(),
    };

    const artifacts = await runOpsIngest(ctx);
    const quality = artifacts.find((a) => a.kind === "data_quality_report");
    assert(quality, "Expected data_quality_report artifact");
    assert(quality.title === "Data Quality Report (SYNTHETIC DEMO DATA)", "Expected synthetic title");

    const parsed = JSON.parse(quality.content);
    assert(parsed.dataOrigin === "synthetic", `Expected dataOrigin === "synthetic", got ${parsed.dataOrigin}`);

    const blockRecord = audit.records.find((r) => r.type === "guardrail_block");
    assert(blockRecord, "Expected guardrail_block audit record");
    const flags = blockRecord.data.flags as string[] | undefined;
    assert(Array.isArray(flags) && flags.includes("synthetic_data"), "Expected synthetic_data flag in audit");
  } finally {
    (config as any).opsAllowSynthetic = prevOptIn;
  }
}

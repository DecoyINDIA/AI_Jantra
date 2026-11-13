# TASK ID: T-002

**Title:** Ops pipeline: no silent synthetic data, honest delivery receipt
**Priority:** P0
**Objective:** `ops-reporting` never substitutes fake data without an explicit opt-in, records where its data came from, and never claims a report was delivered.
**Why This Matters:** The audit trail currently records an email delivery that never happens and can base a report on invented numbers (Audit A-02, A-03). The product's promise is that the record is true.
**Prerequisites:** none.
**Effort & Complexity:** Small effort; low reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-002 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
File: src/pipeline/stages/opsReporting.ts.
- runOpsIngest (starts line 56). After looping over connectors it does, at lines 164-176:
    if (!fetchedAny) { const synthetic = generateSyntheticData(clientId); snapshot.orders = synthetic.orders; … }
  It then runs runQualityBattery and returns two artifacts whose content is JSON text:
    kind "data_snapshot"        content JSON.stringify(dedupedSnapshot, null, 2)
    kind "data_quality_report"  content JSON.stringify(report, null, 2)
  Later stages JSON.parse these contents, so their top-level shape must stay parseable JSON.
- runOpsDeliver (starts line 719) invents recipients, calls ctx.io.say("Delivering operations report to …"),
  and returns a "delivery_receipt" artifact with { channel: "email", recipients, timestamp, artifactHash }.
  Nothing is actually sent anywhere.
- config is imported in this file already (import { config } from "../../config.js"). config.provider is
  "gemini" | "mock" | "openai-compatible".
- StageFailedClosedError is imported already.

FILES TO MODIFY
- src/config.ts                          one new setting
- src/pipeline/stages/opsReporting.ts    two edits
- src/runtime/evals/regressions.ts       two new regressions
- .env.example                           one comment line

IMPLEMENTATION STEPS
1. src/config.ts: add `opsAllowSynthetic: booleanFromEnv("JANTRA_OPS_ALLOW_SYNTHETIC", false),` to config.
2. runOpsIngest:
   a. Declare `let dataOrigin: "connectors" | "synthetic" = "connectors";` before the `if (!fetchedAny)` block.
   b. Make the first statements inside `if (!fetchedAny) {`:
        const syntheticAllowed = config.provider === "mock" || config.opsAllowSynthetic;
        if (!syntheticAllowed) {
          throw new StageFailedClosedError(
            "No operational data could be loaded from any configured source.",
            { projectId: ctx.project.id, clientId, connectors: binding.connectors.map((c) => c.id) },
          );
        }
        dataOrigin = "synthetic";
        ctx.audit.record("guardrail_block", {
          clientId, projectId: ctx.project.id, stage: ctx.stageId,
          reason: "Synthetic demo data substituted because no source returned records.",
          flags: ["synthetic_data"],
        });
      Keep the existing synthetic assignment lines after this.
   c. Change the data_quality_report artifact content to
        JSON.stringify({ ...report, dataOrigin }, null, 2)
      and, when dataOrigin === "synthetic", set that artifact's title to
        "Data Quality Report (SYNTHETIC DEMO DATA)".
      Do NOT change the data_snapshot artifact.
3. runOpsDeliver: replace the body after the "report missing" check with:
     - Compute `hash` exactly as now.
     - Remove the recipient-guessing block and the ctx.io.say("Delivering …") line entirely.
     - ctx.io.say("Report delivery is not configured. The report is ready for manual sending.");
     - Read data origin: find the artifact kind "data_quality_report" in ctx.project.stages["ingest"]?.artifacts,
       JSON.parse its content inside try/catch, take `.dataOrigin` if it is "synthetic" or "connectors",
       else "unknown".
     - Return one artifact kind "delivery_receipt", title "Delivery Receipt (not sent)", content
         JSON.stringify({ status: "not_sent", channel: "none", recipients: [],
                          reason: "No delivery channel is configured.",
                          dataOrigin, timestamp: new Date().toISOString(), artifactHash: hash }, null, 2)
4. .env.example: add near the other optional controls
     # JANTRA_OPS_ALLOW_SYNTHETIC=false   # demo only: let ops-reporting use generated sample data
5. Regressions in src/runtime/evals/regressions.ts (import runOpsIngest, runOpsDeliver from
   "../../pipeline/stages/opsReporting.js" and opsReportingDefinition from "../../agents/opsReporting.js"):
   a. "ops-delivery-honest": create a project with createProject({ clientId: "eval", title: "t",
      definition: opsReportingDefinition }); push a fake artifact { stage: "compose", kind: "ops_report",
      title: "r", content: "# r", version: 1, createdAt: new Date().toISOString() } into
      project.stages.compose.artifacts; build a minimal StageContext (copy how neighbouring regressions build
      one; io = { say() {}, ask: async () => "" }) with stageId "deliver"; call runOpsDeliver(ctx);
      parse the returned artifact content and assert status === "not_sent", channel === "none",
      recipients.length === 0, and that the content does not contain "@".
   b. "ops-no-silent-synthetic": the eval process runs with the mock provider, so assert the opt-in path:
      call runOpsIngest with a fresh ops-reporting project (stageId "ingest"); assert the returned
      data_quality_report content parses and has dataOrigin === "synthetic", and that the audit logger used
      recorded an entry of type "guardrail_block" with flags containing "synthetic_data".
      Additionally add a pure unit assertion on the guard expression by extracting it:
        export function syntheticDataAllowed(provider: string, optIn: boolean): boolean
          { return provider === "mock" || optIn; }
      in opsReporting.ts, use it in step 2b, and assert syntheticDataAllowed("gemini", false) === false,
      syntheticDataAllowed("openai-compatible", false) === false, syntheticDataAllowed("gemini", true) === true.

EDGE CASES
- Connector errors are already caught and audited per connector; do not change that.
- dataOrigin must be "connectors" whenever fetchedAny is true, even if only one source returned rows.
- JSON.parse failure in runOpsDeliver must not throw; use "unknown".

NON-GOALS
- Do not fix the fact that ops-reporting cannot find the kpi-design / source-binding artifacts of an
  ops-onboarding run (separate design decision). Do not touch runOpsAnalyze or runOpsCompose.
- Do not implement email sending. Do not change src/pipeline/ops/fixtures.ts or opsEvals.ts.
- Do not remove the default binding.

ACCEPTANCE CRITERIA
1. The string `channel: "email"` no longer appears in src/pipeline/stages/opsReporting.ts.
2. No code path reaches generateSyntheticData when provider is not "mock" and JANTRA_OPS_ALLOW_SYNTHETIC is unset.
3. npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke all exit 0.
4. Both new regressions are listed as passed in the eval report.

RISK & ROLLBACK
- Risk: a demo that relied on silent synthetic data now fails closed. Mitigation: set JANTRA_OPS_ALLOW_SYNTHETIC=true.
- Rollback: revert the commit.

ESCALATION CONDITIONS — stop and report if:
- runOpsCompose or runOpsAnalyze parse data_quality_report with a strict schema that rejects the extra
  dataOrigin field (search for "data_quality_report" before editing).
- Any existing eval depends on delivery_receipt having channel "email".

Finish with the report format from 07_AGENT_CONTEXT.md.
```

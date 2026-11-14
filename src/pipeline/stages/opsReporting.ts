import { z } from "zod";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { ModelMessage } from "../../model/provider.js";
import { makeEvalScore } from "../../runtime/evaluator.js";
import { SchemaValidationError, StageFailedClosedError, CostCeilingExceededError } from "../../runtime/errors.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import { loadStageExecutionState, saveStageExecutionState } from "../executionState.js";
import { DecryptionError } from "../../security/encryption.js";
import { assertPublicWebhookUrl } from "../../server/webhooks/urlGuard.js";
import { safeFetch, UnsafeUrlError } from "../../util/safeFetch.js";
import type {
  Artifact,
  EvalScore,
  StageContext,
  StageRunner,
} from "../types.js";
import { generateSyntheticData } from "../ops/fixtures.js";
import { runQualityBattery, type SourceBinding } from "../ops/connectors.js";
import { evaluateFormula } from "../ops/formulaEngine.js";
import { scanMetricAnomalies, type AnomalyFinding } from "../ops/anomalyEngine.js";
import { reportCompositionRubric } from "../../runtime/evals/rubrics.js";
import { defaultConnectorRegistry } from "../ops/connectors/registry.js";
import type { DataSnapshot } from "../ops/schema.js";

// --- Cost Ceiling Enforcer ---
function enforceCeiling(ctx: StageContext): void {
  const cost = ctx.project.cost.usd;
  if (cost > config.opsReportCeilingUsd) {
    throw new CostCeilingExceededError(`Ops Reporting run exceeded cost ceiling of $${config.opsReportCeilingUsd}.`, {
      projectId: ctx.project.id,
      clientId: ctx.project.clientId,
      costUsd: cost,
      ceilingUsd: config.opsReportCeilingUsd,
    });
  }
}

// --- Zod critique parser ---
function parseCritique<T>(text: string, schema: z.Schema<T>): T {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("Could not find JSON object boundaries in response.");
    }
    const jsonText = text.slice(start, end + 1);
    const parsed = JSON.parse(jsonText);
    return schema.parse(parsed);
  } catch (err: any) {
    throw new StageFailedClosedError(`Critique response parsing failed: ${err.message}`);
  }
}

// ==========================================
// STAGE 1: Data Ingest (Model-flow runner)
// ==========================================

/**
 * HARD GATE (T-018 / T-019):
 * Do NOT invent or synthesize partner field mappings until real partner export
 * (experiment X5) is provided. Real connector schemas and field mappings must remain
 * grounded in real validated partner data.
 */

export function syntheticDataAllowed(provider: string, optIn: boolean): boolean {
  return provider === "mock" || optIn;
}

export const runOpsIngest: StageRunner = async (ctx) => {
  const clientId = ctx.project.clientId;

  // 1. Load Source Binding to check rules and config (check operator-confirmed profile first)
  const opsProfile = ctx.store.getOpsProfile ? ctx.store.getOpsProfile(clientId) : null;
  let binding: SourceBinding = opsProfile?.binding ?? {
    connectors: [
      { id: "stripe-sub", type: "stripe", role: "subscriptions", config: {} },
      { id: "qb-expense", type: "quickbooks", role: "expenses", config: {} },
      { id: "shopify-sales", type: "shopify", role: "sales", config: {} },
    ],
    overlapRules: [
      { primarySource: "shopify-sales", secondarySource: "stripe-sub", action: "dedup-by-id" },
    ],
  };

  const bindingArtifact = ctx.project.stages["source-binding"]?.artifacts.at(-1);
  if (!opsProfile?.binding && bindingArtifact) {
    try {
      const jsonMatch = bindingArtifact.content.match(/<!-- binding_json:\s*([\s\S]+?)\s*-->/);
      if (jsonMatch) {
        binding = JSON.parse(jsonMatch[1]!);
      } else {
        const parsed = JSON.parse(bindingArtifact.content.slice(bindingArtifact.content.indexOf("{"), bindingArtifact.content.lastIndexOf("}") + 1));
        binding = parsed;
      }
    } catch {
      // fallback to default
    }
  }

  // 2. Fetch data dynamically from all configured connectors
  const snapshot: DataSnapshot = {
    orders: [],
    order_lines: [],
    invoices: [],
    payments: [],
    expenses: [],
    subscription_events: [],
    customers: [],
    products: [],
    channels: [],
    calendar: [],
  };

  let fetchedAny = false;
  for (const conn of binding.connectors) {
    if (["stripe", "shopify", "csv"].includes(conn.type)) {
      try {
        const connector = defaultConnectorRegistry.get(conn.type, conn.id);
        let credentials: Record<string, string> | undefined = undefined;

        if (conn.type === "stripe" || conn.type === "shopify") {
          try {
            const creds = ctx.store.getConnectorCredentials
              ? ctx.store.getConnectorCredentials(clientId, conn.type)
              : null;
            if (creds && Object.keys(creds).length > 0) {
              credentials = creds;
            }
          } catch (err: any) {
            // Fail closed immediately on decryption error
            ctx.audit.record("error", {
              clientId,
              projectId: ctx.project.id,
              stage: ctx.stageId,
              message: `Credential decryption failed for connector ${conn.id} (${conn.type}): ${err.message}`,
            });
            throw new StageFailedClosedError(
              `Failed to decrypt credentials for connector ${conn.id} (${conn.type}): ${err.message}`,
              { clientId, connectorId: conn.id, connectorType: conn.type },
            );
          }

          if (!credentials && !syntheticDataAllowed(config.provider, config.opsAllowSynthetic)) {
            throw new StageFailedClosedError(
              `Missing credentials for connector ${conn.id} (${conn.type}) for client ${clientId}.`,
              { clientId, connectorId: conn.id, connectorType: conn.type },
            );
          }
        }

        const data = await connector.fetch({
          clientId,
          config: { ...conn.config, role: conn.role },
          credentials,
        });

        if (data.orders) snapshot.orders.push(...data.orders);
        if (data.order_lines) snapshot.order_lines.push(...data.order_lines);
        if (data.invoices) snapshot.invoices.push(...data.invoices);
        if (data.payments) snapshot.payments.push(...data.payments);
        if (data.expenses) snapshot.expenses.push(...data.expenses);
        if (data.subscription_events) snapshot.subscription_events.push(...data.subscription_events);
        if (data.customers) {
          for (const cust of data.customers) {
            if (!snapshot.customers.some((c) => c.id === cust.id)) {
              snapshot.customers.push(cust);
            }
          }
        }
        if (data.products) {
          for (const prod of data.products) {
            if (!snapshot.products.some((p) => p.id === prod.id)) {
              snapshot.products.push(prod);
            }
          }
        }
        if (data.channels) {
          for (const chan of data.channels) {
            if (!snapshot.channels.some((ch) => ch.id === chan.id)) {
              snapshot.channels.push(chan);
            }
          }
        }
        if (data.calendar) snapshot.calendar.push(...data.calendar);

        const hasRecords =
          (data.orders?.length ?? 0) > 0 ||
          (data.invoices?.length ?? 0) > 0 ||
          (data.expenses?.length ?? 0) > 0 ||
          (data.subscription_events?.length ?? 0) > 0;

        if (hasRecords) {
          fetchedAny = true;
        }
      } catch (err: any) {
        if (err instanceof StageFailedClosedError) {
          throw err;
        }
        ctx.audit.record("error", {
          clientId,
          projectId: ctx.project.id,
          stage: ctx.stageId,
          message: `Connector ${conn.id} fetch failed or skipped: ${err.message}`,
        });
      }
    }
  }

  let dataOrigin: "connectors" | "synthetic" = "connectors";

  // 3. Fallback to synthetic data if no real data was fetched (keeps tests/evals happy)
  if (!fetchedAny) {
    const syntheticAllowed = syntheticDataAllowed(config.provider, config.opsAllowSynthetic);
    if (!syntheticAllowed) {
      throw new StageFailedClosedError(
        "No operational data could be loaded from any configured source.",
        { projectId: ctx.project.id, clientId, connectors: binding.connectors.map((c) => c.id) },
      );
    }
    dataOrigin = "synthetic";
    ctx.audit.record("guardrail_block", {
      clientId,
      projectId: ctx.project.id,
      stage: ctx.stageId,
      reason: "Synthetic demo data substituted because no source returned records.",
      flags: ["synthetic_data"],
    });
    const synthetic = generateSyntheticData(clientId);
    snapshot.orders = synthetic.orders;
    snapshot.order_lines = synthetic.order_lines;
    snapshot.invoices = synthetic.invoices;
    snapshot.payments = synthetic.payments;
    snapshot.expenses = synthetic.expenses;
    snapshot.subscription_events = synthetic.subscription_events;
    snapshot.customers = synthetic.customers;
    snapshot.products = synthetic.products;
    snapshot.channels = synthetic.channels;
    snapshot.calendar = synthetic.calendar;
  } else {
    if (!snapshot.channels.length) {
      snapshot.channels = [
        { id: "stripe", name: "Stripe" },
        { id: "shopify", name: "Shopify" },
        { id: "csv", name: "CSV" },
      ];
    }
    if (!snapshot.calendar.length) {
      const dates = new Set<string>();
      const addDate = (d?: string) => { if (d) dates.add(d); };
      snapshot.orders.forEach((o) => addDate(o.orderDate));
      snapshot.invoices.forEach((i) => addDate(i.invoiceDate));
      snapshot.expenses.forEach((e) => addDate(e.expenseDate));
      snapshot.subscription_events.forEach((s) => addDate(s.eventDate));

      const sortedDates = [...dates].sort();
      if (sortedDates.length > 0) {
        const start = new Date(sortedDates[0]!);
        const end = new Date(sortedDates[sortedDates.length - 1]!);
        const curr = new Date(start);
        while (curr <= end) {
          const dateStr = curr.toISOString().slice(0, 10);
          const isHoliday = (curr.getMonth() === 11 && curr.getDate() === 25) || (curr.getMonth() === 0 && curr.getDate() === 1);
          snapshot.calendar.push({
            date: dateStr,
            week: Math.ceil(curr.getDate() / 7),
            month: curr.getMonth() + 1,
            year: curr.getFullYear(),
            isHoliday,
            isPromo: false,
          });
          curr.setDate(curr.getDate() + 1);
        }
      }
    }
  }

  // 4. Run Quality Battery (returns deduplicated snapshot copy to avoid mutations)
  const { report, snapshot: dedupedSnapshot } = runQualityBattery(snapshot, binding);

  if (report.verdict === "fail") {
    throw new StageFailedClosedError("Data Ingest failed due to failed validation checks.", {
      projectId: ctx.project.id,
      checks: report.checks,
    });
  }

  return [
    {
      stage: ctx.stageId,
      kind: "data_snapshot",
      title: "Data Snapshot",
      content: JSON.stringify(dedupedSnapshot, null, 2),
      version: 1,
      createdAt: new Date().toISOString(),
    },
    {
      stage: ctx.stageId,
      kind: "data_quality_report",
      title: dataOrigin === "synthetic" ? "Data Quality Report (SYNTHETIC DEMO DATA)" : "Data Quality Report",
      content: JSON.stringify({ ...report, dataOrigin }, null, 2),
      version: 1,
      createdAt: new Date().toISOString(),
    },
  ];
};

// ==========================================
// STAGE 2: Data Analysis (Strictly model-free)
// ==========================================

export const runOpsAnalyze: StageRunner = async (ctx) => {
  const snapshotArtifact = ctx.project.stages["ingest"]?.artifacts.find((a) => a.kind === "data_snapshot");
  if (!snapshotArtifact) {
    throw new StageFailedClosedError("Required ingest snapshot artifact is missing.");
  }

  // Load KPI spec & profile: first check operator-confirmed reporting profile in store
  const opsProfile = ctx.store.getOpsProfile ? ctx.store.getOpsProfile(ctx.project.clientId) : null;
  let kpiSpec: any = opsProfile?.kpiSpec ?? null;
  let kpisList: any[] = kpiSpec?.kpis ?? [];
  let knownEvents: any[] = opsProfile?.knownEvents ?? [];

  if (!kpiSpec) {
    const specArtifact = ctx.project.stages["kpi-design"]?.artifacts.at(-1);
    if (!specArtifact) {
      throw new StageFailedClosedError("Required onboarding reporting profile or KPI design artifacts are missing.");
    }

    try {
      const jsonMatch = specArtifact.content.match(/<!-- kpis_json:\s*([\s\S]+?)\s*-->/);
      if (jsonMatch) {
        kpiSpec = JSON.parse(jsonMatch[1]!);
      } else {
        const kpiJsonText = specArtifact.content.slice(specArtifact.content.indexOf("{"), specArtifact.content.lastIndexOf("}") + 1);
        kpiSpec = JSON.parse(kpiJsonText);
      }
      kpisList = kpiSpec.kpis || [];
    } catch (err) {
      throw new StageFailedClosedError("KPI specifications JSON metadata was not found or failed parsing in the KPI artifact.");
    }

    const profileArtifact = ctx.project.stages.profile?.artifacts.at(-1);
    if (profileArtifact) {
      const jsonMatch = profileArtifact.content.match(/<!-- profile_json:\s*([\s\S]+?)\s*-->/);
      if (jsonMatch) {
        try {
          const profileData = JSON.parse(jsonMatch[1]!);
          knownEvents = profileData.knownEvents || [];
        } catch {
          // ignore
        }
      }
    }
  }

  const snapshot = JSON.parse(snapshotArtifact.content);

  // 1. Get unique sorted month list (from calendar dates: YYYY-MM)
  const monthsSet = new Set<string>();
  for (const cal of snapshot.calendar) {
    monthsSet.add(cal.date.slice(0, 7));
  }
  const timestamps = [...monthsSet].sort();
  if (timestamps.length < 1) {
    throw new StageFailedClosedError("No data periods found in calendar.");
  }

  const currentPeriod = timestamps[timestamps.length - 1]!; // e.g. "2026-06"
  const priorPeriod = timestamps.length >= 2 ? timestamps[timestamps.length - 2]! : null; // e.g. "2026-05"
  const yoyPeriod = timestamps.length >= 13 ? timestamps[timestamps.length - 13]! : null;

  const kpiResults: any[] = [];
  const allFindings: AnomalyFinding[] = [];

  // Evaluate each KPI
  for (const kpi of kpisList) {
    const series: number[] = [];
    for (const ts of timestamps) {
      const val = evaluateFormula(kpi.formula, snapshot, `${ts}-01`, `${ts}-31`);
      series.push(val);
    }

    const currentVal = series[series.length - 1]!;
    let priorVal: number | null = null;
    let popDelta: number | null = null;
    let popDeltaPct: number | null = null;

    if (priorPeriod) {
      priorVal = series[series.length - 2]!;
      popDelta = currentVal - priorVal;
      popDeltaPct = priorVal === 0 ? 0 : popDelta / priorVal;
    }

    let yoyVal: number | null = null;
    let yoyDelta: number | null = null;
    let yoyDeltaPct: number | null = null;

    if (yoyPeriod && series.length >= 13) {
      yoyVal = series[series.length - 13]!;
      yoyDelta = currentVal - yoyVal;
      yoyDeltaPct = yoyVal === 0 ? 0 : yoyDelta / yoyVal;
    }

    const historySufficient = series.length >= kpi.minHistoryPeriods;

    kpiResults.push({
      kpiId: kpi.id,
      name: kpi.name,
      value: Number(currentVal.toFixed(2)),
      priorValue: priorVal !== null ? Number(priorVal.toFixed(2)) : null,
      popDelta: popDelta !== null ? Number(popDelta.toFixed(2)) : null,
      popDeltaPct: popDeltaPct !== null ? Number((popDeltaPct * 100).toFixed(1)) : null,
      yoyValue: yoyVal !== null ? Number(yoyVal.toFixed(2)) : null,
      yoyDelta: yoyDelta !== null ? Number(yoyDelta.toFixed(2)) : null,
      yoyDeltaPct: yoyDeltaPct !== null ? Number((yoyDeltaPct * 100).toFixed(1)) : null,
      historySufficient,
    });

    // Run anomaly scan ONLY if history is sufficient
    if (historySufficient) {
      const sensitivity = kpiSpec.anomalyConfig?.sensitivity || "medium";
      const suppressionList = kpiSpec.anomalyConfig?.suppressionList || [];

      if (!suppressionList.includes(kpi.id)) {
        const findings = scanMetricAnomalies(
          kpi.id,
          series,
          timestamps,
          sensitivity,
          12, // seasonal period (yearly)
          knownEvents,
          snapshot,
          kpi.minHistoryPeriods,
        );
        allFindings.push(...findings);
      }
    }
  }

  // Do not slice findings here, pass all findings so Compose decides body/appendix
  const finalFindings = allFindings.sort((a, b) => b.severity - a.severity);

  return [
    {
      stage: ctx.stageId,
      kind: "kpi_results",
      title: "KPI Results",
      content: JSON.stringify(kpiResults, null, 2),
      version: 1,
      createdAt: new Date().toISOString(),
    },
    {
      stage: ctx.stageId,
      kind: "anomaly_findings",
      title: "Anomaly Findings",
      content: JSON.stringify(finalFindings, null, 2),
      version: 1,
      createdAt: new Date().toISOString(),
    },
  ];
};

// ==========================================
// STAGE 3: Report Composition (Generator + Critic)
// ==========================================

const ReportCritiqueSchema = z.object({
  scores: z.object({
    numericalFidelity: z.number().min(1).max(5),
    faithfulness: z.number().min(1).max(5),
    readiness: z.number().min(1).max(5),
    audienceFit: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
});

/**
 * Extracts and normalizes all numbers from a markdown text
 */
export function extractNumbersFromText(text: string): Set<number> {
  const numberRegex = /-?\b\d+(?:,\d+)*(?:\.\d+)?%?\b/g;
  const numbers = new Set<number>();
  let match;
  while ((match = numberRegex.exec(text)) !== null) {
    const rawStr = match[0]!.replace(/,/g, "").replace(/%/, "");
    const val = Number(rawStr);
    if (Number.isFinite(val)) {
      numbers.add(val);
      numbers.add(Math.round(val));
      numbers.add(Math.floor(val));
    }
  }
  return numbers;
}

/**
 * Accumulates all valid calculated values from fact tables to check against
 */
export function getValidNumbersSet(kpis: any[], findings: AnomalyFinding[]): Set<number> {
  const valid = new Set<number>();
  // Allow basic small integers 0, 1, 2 only. Whitelist years 2025, 2026.
  valid.add(0);
  valid.add(1);
  valid.add(2);
  valid.add(2025);
  valid.add(2026);

  for (const k of kpis) {
    const values = [k.value, k.priorValue, k.popDelta, k.popDeltaPct, k.yoyValue, k.yoyDelta, k.yoyDeltaPct];
    for (const v of values) {
      if (v !== null && v !== undefined) {
        valid.add(v);
        valid.add(v * 100); // add ratio scaled percent representation (e.g. 0.62 -> 62)
        valid.add(Math.round(v));
        valid.add(Math.round(v * 100));
        valid.add(Math.floor(v));
        valid.add(Math.floor(v * 100));
      }
    }
  }

  for (const f of findings) {
    const values = [f.actual, f.expectedLow, f.expectedHigh, f.severity * 100];
    for (const v of values) {
      if (v !== null && v !== undefined) {
        valid.add(v);
        valid.add(Math.round(v));
        valid.add(Math.floor(v));
      }
    }
    for (const d of f.drivers) {
      const v = d.contribution * 100;
      valid.add(v);
      valid.add(Math.round(v));
      valid.add(Math.floor(v));
    }
  }

  return valid;
}

/**
 * Number Provenance Verifier
 */
export function verifyNumberProvenance(report: string, validNumbers: Set<number>): { valid: boolean; orphanNumbers: number[] } {
  const textNums = extractNumbersFromText(report);
  const orphans: number[] = [];

  for (const n of textNums) {
    // Whitelisted years and small constants
    if (n === 0 || n === 1 || n === 2) continue;
    if (n === 2025 || n === 2026) continue;
    
    // Check if the number matches any valid calculated number (tolerance of 0.1)
    let found = false;
    for (const v of validNumbers) {
      if (Math.abs(v - n) < 0.1) {
        found = true;
        break;
      }
    }

    if (!found) {
      orphans.push(n);
    }
  }

  return {
    valid: orphans.length === 0,
    orphanNumbers: orphans,
  };
}

/**
 * Code-enforces warning inclusion and history warnings in narrative
 */
function verifyReportRequirements(
  report: string,
  kpis: any[],
  quality: any,
): { valid: boolean; error?: string } {
  const reportLower = report.toLowerCase();

  // 1. Verify history warning mentions for young businesses/insufficient history
  for (const k of kpis) {
    if (k.historySufficient === false) {
      const nameLower = k.name.toLowerCase();
      const idLower = k.kpiId.toLowerCase();
      const hasKpi = reportLower.includes(nameLower) || reportLower.includes(idLower);
      const hasHistoryWarning = reportLower.includes("history") || reportLower.includes("insufficient");
      if (!hasKpi || !hasHistoryWarning) {
        return {
          valid: false,
          error: `Report narrative must state that KPI "${k.name}" has insufficient history to determine trends or anomalies.`,
        };
      }
    }
  }

  // 2. Verify pass-with-warnings caveats are mentioned
  if (quality && quality.verdict === "pass-with-warnings") {
    const warnings = quality.checks.filter((c: any) => c.status === "warn");
    for (const w of warnings) {
      const hasWarningText = reportLower.includes("warning") || reportLower.includes("caveat") || reportLower.includes("data quality") || reportLower.includes("reconciliation");
      if (!hasWarningText) {
        return {
          valid: false,
          error: `Report narrative must contain a caveat or warning section referencing the data quality issues: "${w.detail}".`,
        };
      }
    }
  }

  return { valid: true };
}

async function critiqueReport(
  ctx: StageContext,
  report: string,
): Promise<EvalScore> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system: "You are Lekha's critique supervisor. Score the operations report narrative on numericalFidelity, faithfulness of statistics, readiness for review, and audienceFit. Score 1-5, all must pass >= 4. Return JSON only.",
    messages: [
      { role: "user", content: `Report:\n${report}` },
    ],
    responseJsonSchema: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            numericalFidelity: { type: "number" },
            faithfulness: { type: "number" },
            readiness: { type: "number" },
            audienceFit: { type: "number" },
          },
          required: ["numericalFidelity", "faithfulness", "readiness", "audienceFit"],
        },
        passed: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["scores", "passed", "notes"],
    },
    thinking: true,
    maxOutputTokens: 3000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  enforceCeiling(ctx);
  const parsed = parseCritique(result.text, ReportCritiqueSchema);
  const evalScore = makeEvalScore(reportCompositionRubric, parsed.scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return evalScore;
}

export const runOpsCompose: StageRunner = async (ctx) => {
  const kpiArtifact = ctx.project.stages.analyze?.artifacts.find((a) => a.kind === "kpi_results");
  const findingsArtifact = ctx.project.stages.analyze?.artifacts.find((a) => a.kind === "anomaly_findings");
  const qualityArtifact = ctx.project.stages.ingest?.artifacts.find((a) => a.kind === "data_quality_report");

  if (!kpiArtifact || !findingsArtifact) {
    throw new StageFailedClosedError("Analysis results are missing.");
  }

  const kpis = JSON.parse(kpiArtifact.content);
  const findings = JSON.parse(findingsArtifact.content);
  const quality = qualityArtifact ? JSON.parse(qualityArtifact.content) : null;

  const validNumbers = getValidNumbersSet(kpis, findings);

  let reportContent = "";
  let attempts = 0;
  const maxAttempts = 3;

  const messages: ModelMessage[] = [
    { role: "user", content: "Write the operations report." },
  ];
  if (ctx.rejectionReason) {
    messages.push({
      role: "user",
      content: `The previous report draft was rejected with feedback: "${ctx.rejectionReason}". Please revise to address this feedback.`,
    });
  }

  // Retrieve alert budget from stored profile or design spec if available
  const opsProfile = ctx.store.getOpsProfile ? ctx.store.getOpsProfile(ctx.project.clientId) : null;
  let alertBudget = opsProfile?.kpiSpec?.anomalyConfig?.alertBudget ?? 5;
  if (!opsProfile?.kpiSpec?.anomalyConfig?.alertBudget) {
    const specArtifact = ctx.project.stages["kpi-design"]?.artifacts.at(-1);
    if (specArtifact) {
      try {
        const jsonMatch = specArtifact.content.match(/<!-- kpis_json:\s*([\s\S]+?)\s*-->/);
        if (jsonMatch) {
          const kpiSpec = JSON.parse(jsonMatch[1]!);
          alertBudget = kpiSpec.anomalyConfig?.alertBudget || 5;
        }
      } catch {
        // ignore
      }
    }
  }

  while (attempts < maxAttempts) {
    attempts++;
    const result = await ctx.provider.generate({
      purpose: "generator",
      system: `You are Lekha, the precise, calm, and meticulous operations reporting compiler.
Your voice is unhurried, honest, and precise. You state numbers exactly as computed.

Write the operations report narrative based ONLY on these facts:
KPIs: ${JSON.stringify(kpis)}
Anomalies: ${JSON.stringify(findings)}
Data Quality: ${JSON.stringify(quality)}

Rules:
1. Every numeric figure must match one of the calculated KPI or anomaly fields. Do not invent any numbers.
2. Report the summary, target variances, anomalies with segment drivers, and data caveats upfront.
3. State co-occurrence of events, but never assume or state unverified causality.
4. Keep the tone calm, direct, and completely factual. No marketing fluff.
5. The alert budget is ${alertBudget}. Put the top ${alertBudget} findings in the report body, and put the rest in the appendix.`,
      messages,
      thinking: true,
      maxOutputTokens: 8000,
    });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);
    enforceCeiling(ctx);
    reportContent = result.text;

    // Check Number Provenance
    const prov = verifyNumberProvenance(reportContent, validNumbers);
    const reqs = verifyReportRequirements(reportContent, kpis, quality);

    if (prov.valid && reqs.valid) {
      break;
    }

    let errorDetail = "";
    if (!prov.valid) {
      errorDetail += `Orphan numbers detected: ${prov.orphanNumbers.join(", ")}. `;
    }
    if (!reqs.valid) {
      errorDetail += `${reqs.error} `;
    }

    ctx.audit.record("error", {
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
      stage: ctx.stageId,
      error: `Report verification failed: ${errorDetail}`,
    });

    if (attempts === maxAttempts) {
      throw new StageFailedClosedError(`Report composition failed due to verification issues: ${errorDetail}`);
    }

    // Append verification correction attempt to loop
    messages.push({
      role: "user",
      content: `Your previous draft had verification issues: ${errorDetail}. Please regenerate and correct this.`,
    });
  }

  // Run Critic
  const evalScore = await critiqueReport(ctx, reportContent);
  ctx.project.stages[ctx.stageId]!.evals.push(evalScore);

  if (!evalScore.passed) {
    throw new StageFailedClosedError("Ops report composition did not pass rubric checks.");
  }

  return [
    {
      stage: ctx.stageId,
      kind: "ops_report",
      title: "Operations Report",
      content: reportContent,
      version: 1,
      createdAt: new Date().toISOString(),
      eval: evalScore,
    },
  ];
};

// ==========================================
// STAGE 4: Report Delivery (Tool loop)
// ==========================================

export interface WebhookDeliveryOutcome {
  ok: boolean;
  statusCode?: number;
  statusText?: string;
  body?: string;
  error?: string;
}

export type ReportFetchFn = (
  url: string,
  init?: RequestInit,
  opts?: any,
) => Promise<Response>;

export async function deliverReportWebhook(
  url: string,
  secret: string | undefined,
  payload: Record<string, unknown>,
  attempts = 3,
  fetchFn: ReportFetchFn = safeFetch,
): Promise<WebhookDeliveryOutcome> {
  if (fetchFn === safeFetch) {
    try {
      await assertPublicWebhookUrl(url);
    } catch (err: any) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const body = JSON.stringify(payload);
  const signature = secret
    ? createHmac("sha256", secret).update(body).digest("hex")
    : undefined;

  let lastError: string | undefined;
  let lastStatus: number | undefined;
  let lastStatusText: string | undefined;
  let lastResponseBody: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchFn(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Jantra-Event": "ops.report_delivered",
            ...(signature ? { "X-Jantra-Signature": signature } : {}),
            "X-Jantra-Delivery": String(payload.id || randomUUID()),
          },
          body,
        },
        { timeoutMs: 10_000, maxRedirects: 0, maxBytes: 64_000 },
      );

      lastStatus = response.status;
      lastStatusText = response.statusText;
      try {
        lastResponseBody = (await response.text()).slice(0, 2048);
      } catch {}

      if (response.ok) {
        return {
          ok: true,
          statusCode: lastStatus,
          statusText: lastStatusText,
          body: lastResponseBody,
        };
      }

      // Non-retryable client error (4xx other than 429) -> stop immediately
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return {
          ok: false,
          statusCode: lastStatus,
          statusText: lastStatusText,
          body: lastResponseBody,
          error: `Webhook delivery failed with non-retryable HTTP ${response.status}.`,
        };
      }

      lastError = `Webhook delivery failed with HTTP ${response.status}.`;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    } catch (err: any) {
      lastError = err.message || String(err);
      if (err instanceof UnsafeUrlError) {
        return { ok: false, error: `Unsafe webhook URL: ${err.message}` };
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  return {
    ok: false,
    statusCode: lastStatus,
    statusText: lastStatusText,
    body: lastResponseBody,
    error: lastError || "Webhook delivery failed after retries.",
  };
}

export const runOpsDeliver: StageRunner = async (ctx) => {
  const reportArtifact = ctx.project.stages.compose?.artifacts.find((a) => a.kind === "ops_report");
  if (!reportArtifact) throw new StageFailedClosedError("Operations report is missing.");

  let dataOrigin: "synthetic" | "connectors" | "unknown" = "unknown";
  const qualityArtifact = ctx.project.stages.ingest?.artifacts.find((a) => a.kind === "data_quality_report");
  if (qualityArtifact) {
    try {
      const parsed = JSON.parse(qualityArtifact.content);
      if (parsed.dataOrigin === "synthetic" || parsed.dataOrigin === "connectors") {
        dataOrigin = parsed.dataOrigin;
      }
    } catch {
      // keep unknown
    }
  }

  // Calculate actual SHA-256 hash of the report
  const hash = "sha256-" + createHash("sha256").update(reportArtifact.content).digest("hex");

  // Check stored operator-confirmed reporting profile for delivery channel
  const opsProfile = ctx.store.getOpsProfile ? ctx.store.getOpsProfile(ctx.project.clientId) : null;
  const deliveryConfig = opsProfile?.delivery;

  if (deliveryConfig?.channel === "webhook" && deliveryConfig.webhookUrl) {
    const deliveryId = randomUUID();
    const payload = {
      id: deliveryId,
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
      type: "ops.report_delivered",
      createdAt: new Date().toISOString(),
      artifactHash: hash,
      report: {
        title: reportArtifact.title,
        content: reportArtifact.content,
        version: reportArtifact.version,
      },
      dataOrigin,
    };

    const fetchFn = (ctx as any).fetchFn ?? safeFetch;
    const deliveryOutcome = await deliverReportWebhook(
      deliveryConfig.webhookUrl,
      deliveryConfig.webhookSecret,
      payload,
      3,
      fetchFn,
    );

    const timestamp = new Date().toISOString();

    if (deliveryOutcome.ok) {
      ctx.io.say(`Operations report delivered via signed webhook to ${deliveryConfig.webhookUrl}.`);
      ctx.audit.record("report_delivered", {
        clientId: ctx.project.clientId,
        projectId: ctx.project.id,
        stage: ctx.stageId,
        channel: "webhook",
        url: deliveryConfig.webhookUrl,
        status: "sent",
        statusCode: deliveryOutcome.statusCode,
        artifactHash: hash,
      });

      return [
        {
          stage: ctx.stageId,
          kind: "delivery_receipt",
          title: "Delivery Receipt",
          content: JSON.stringify(
            {
              status: "sent",
              channel: "webhook",
              url: deliveryConfig.webhookUrl,
              recipients: [deliveryConfig.webhookUrl],
              timestamp,
              artifactHash: hash,
              dataOrigin,
              providerResponse: {
                statusCode: deliveryOutcome.statusCode,
                statusText: deliveryOutcome.statusText,
                body: deliveryOutcome.body,
              },
            },
            null,
            2,
          ),
          version: 1,
          createdAt: timestamp,
        },
      ];
    } else {
      ctx.io.say(`Report delivery failed to ${deliveryConfig.webhookUrl}: ${deliveryOutcome.error}`);
      ctx.audit.record("error", {
        clientId: ctx.project.clientId,
        projectId: ctx.project.id,
        stage: ctx.stageId,
        channel: "webhook",
        url: deliveryConfig.webhookUrl,
        status: "failed",
        statusCode: deliveryOutcome.statusCode,
        error: deliveryOutcome.error,
        artifactHash: hash,
      });

      return [
        {
          stage: ctx.stageId,
          kind: "delivery_receipt",
          title: "Delivery Receipt (failed)",
          content: JSON.stringify(
            {
              status: "failed",
              channel: "webhook",
              url: deliveryConfig.webhookUrl,
              recipients: [deliveryConfig.webhookUrl],
              timestamp,
              artifactHash: hash,
              dataOrigin,
              error: deliveryOutcome.error,
              providerResponse: deliveryOutcome.statusCode ? {
                statusCode: deliveryOutcome.statusCode,
                statusText: deliveryOutcome.statusText,
                body: deliveryOutcome.body,
              } : undefined,
            },
            null,
            2,
          ),
          version: 1,
          createdAt: timestamp,
        },
      ];
    }
  }

  ctx.io.say("Report delivery is not configured. The report is ready for manual sending.");

  return [
    {
      stage: ctx.stageId,
      kind: "delivery_receipt",
      title: "Delivery Receipt (not sent)",
      content: JSON.stringify(
        {
          status: "not_sent",
          channel: "none",
          recipients: [],
          reason: "No delivery channel is configured.",
          dataOrigin,
          timestamp: new Date().toISOString(),
          artifactHash: hash,
        },
        null,
        2,
      ),
      version: 1,
      createdAt: new Date().toISOString(),
    },
  ];
};

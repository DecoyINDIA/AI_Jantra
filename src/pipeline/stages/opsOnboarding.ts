import { z } from "zod";
import { config } from "../../config.js";
import type { ModelMessage, ToolSpec } from "../../model/provider.js";
import { makeEvalScore } from "../../runtime/evaluator.js";
import { SchemaValidationError, StageFailedClosedError, CostCeilingExceededError } from "../../runtime/errors.js";
import {
  createQuestionInteraction,
  pendingInteraction,
  upsertPendingInteraction,
} from "../../runtime/interactions.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import {
  createStageExecutionState,
  loadStageExecutionState,
  saveStageExecutionState,
} from "../executionState.js";
import type { StageRunStep } from "../reentrant.js";
import type {
  Artifact,
  EvalScore,
  InteractionResponse,
  PersistedStageState,
  StageContext,
  StageRunner,
} from "../types.js";
import { KPI_CATALOG } from "../ops/kpiCatalog.js";
import { validateFormula } from "../ops/formulaEngine.js";
import { profileRubric, kpiDesignRubric, sourceBindingRubric } from "../../runtime/evals/rubrics.js";

// --- Cost Ceiling Enforcer ---
function enforceCeiling(ctx: StageContext): void {
  const cost = ctx.project.cost.usd;
  if (cost > config.opsOnboardCeilingUsd) {
    throw new CostCeilingExceededError(`Ops Onboarding run exceeded cost ceiling of $${config.opsOnboardCeilingUsd}.`, {
      projectId: ctx.project.id,
      clientId: ctx.project.clientId,
      costUsd: cost,
      ceilingUsd: config.opsOnboardCeilingUsd,
    });
  }
}

// --- Reentrant helper ---
function awaitingQuestion(
  ctx: StageContext,
  state: PersistedStageState,
  prompt: string,
): StageRunStep {
  const existing = pendingInteraction(ctx.project, state.pendingInteractionId);
  const interaction =
    existing ?? upsertPendingInteraction(ctx.project, createQuestionInteraction(ctx.project, ctx.stageId, prompt));
  state.pendingInteractionId = interaction.id;
  saveStageExecutionState(ctx.project, ctx.stageId, state);
  return { status: "awaiting_input", state, interaction };
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
// STAGE 1: Profile (Reentrant)
// ==========================================

const BusinessProfileSchema = z.object({
  businessName: z.string().min(2).max(100),
  description: z.string().min(10).max(500),
  businessModel: z.enum([
    "ecommerce",
    "saas-subscription",
    "services",
    "retail-pos",
    "hospitality",
    "wholesale-manufacturing",
    "other"
  ]),
  revenueStreams: z.array(z.string()).min(1),
  costStructure: z.array(z.string()).min(1),
  fiscalCalendar: z.string().default("January-December"),
  currency: z.string().default("USD"),
  seasonalityExpectations: z.string(),
  knownEvents: z.array(z.object({
    name: z.string(),
    date: z.string(),
    type: z.enum(["promo", "holiday", "one-off"]),
    description: z.string().optional(),
  })).default([]),
  dataSources: z.array(z.object({
    name: z.string(),
    role: z.string(),
  })).min(1),
  reportingCadence: z.enum(["weekly", "bi-weekly", "monthly"]).default("monthly"),
  reportAudience: z.string().default("Management / Owners"),
  reportTone: z.string().default("precise, calm, plain-spoken"),
  openQuestions: z.array(z.string()).default([]),
});

type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

const ProfileCritiqueSchema = z.object({
  scores: z.object({
    factualFidelity: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
    honestGapsDiscipline: z.number().min(1).max(5),
    actionability: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
  followUpQuestions: z.array(z.string()).default([]),
});

const profileSubmitTool: ToolSpec = {
  name: "submit_business_profile",
  description: "Submit the final business profile details compiled from the interview.",
  inputSchema: {
    type: "object",
    properties: {
      businessName: { type: "string" },
      description: { type: "string" },
      businessModel: { type: "string", enum: ["ecommerce", "saas-subscription", "services", "retail-pos", "hospitality", "wholesale-manufacturing", "other"] },
      revenueStreams: { type: "array", items: { type: "string" } },
      costStructure: { type: "array", items: { type: "string" } },
      fiscalCalendar: { type: "string" },
      currency: { type: "string" },
      seasonalityExpectations: { type: "string" },
      knownEvents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            date: { type: "string" },
            type: { type: "string", enum: ["promo", "holiday", "one-off"] },
            description: { type: "string" },
          },
          required: ["name", "date", "type"],
        },
      },
      dataSources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
          },
          required: ["name", "role"],
        },
      },
      reportingCadence: { type: "string", enum: ["weekly", "bi-weekly", "monthly"] },
      reportAudience: { type: "string" },
      reportTone: { type: "string" },
      openQuestions: { type: "array", items: { type: "string" } },
    },
    required: ["businessName", "description", "businessModel", "revenueStreams", "costStructure", "dataSources", "seasonalityExpectations"],
  },
};

const PROFILE_SYSTEM_PROMPT = `You are Lekha, the precise, calm, and meticulous operations onboarding guide.
Your voice is unhurried, clean, and helpful. You state facts without hype.

Your goal is to interview the business owner to build a clear 'business_profile'.
Ask at most two questions at a time. Guide the conversation to understand:
1. Business name and what they do.
2. Business model classification (ecommerce, saas-subscription, services, retail-pos, hospitality, wholesale-manufacturing, other).
3. Primary revenue streams and cost drivers.
4. Operational data sources they use (CSV uploads, Stripe, Shopify, QuickBooks, Xero).
5. Seasonality, holiday promos, or major events.

Keep questions plain and clear. Offer options or candidate answers where possible.
Once you have collected the answers (typically in 2-3 rounds), call the 'submit_business_profile' tool.`;

function renderProfileMarkdown(p: BusinessProfile): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const events = p.knownEvents.map((e) => `- ${e.name} (${e.date}, ${e.type})`).join("\n");
  const sources = p.dataSources.map((s) => `- ${s.name} (${s.role})`).join("\n");
  return `# Business Profile - ${p.businessName}

## Description
${p.description}

## Business Model
${p.businessModel}

## Revenue Streams
${list(p.revenueStreams)}

## Cost Structure
${list(p.costStructure)}

## Fiscal Calendar & Currency
- Calendar: ${p.fiscalCalendar}
- Currency: ${p.currency}

## Seasonality expectations
${p.seasonalityExpectations}

## Known Events
${events || "- None registered"}

## Connected Data Sources
${sources}

## Reporting preferences
- Cadence: ${p.reportingCadence}
- Audience: ${p.reportAudience}
- Tone: ${p.reportTone}

## Open Questions
${list(p.openQuestions) || "- None"}

<!-- profile_meta: model=${p.businessModel}; cadence=${p.reportingCadence}; currency=${p.currency} -->
<!-- profile_json: ${JSON.stringify(p)} -->
`;
}

async function critiqueProfile(
  ctx: StageContext,
  profile: BusinessProfile,
): Promise<{ eval: EvalScore; followUps: string[] }> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system: "You are the profile critique agent. Score the business profile on factualFidelity (nothing invented), completeness (all sections populated), honestGapsDiscipline (unknowns listed in openQuestions), and actionability. Rubric scores must be 1-5. All must pass >= 4. Return JSON with scores, passed boolean, notes, and optional followUpQuestions.",
    messages: [
      { role: "user", content: JSON.stringify(profile, null, 2) },
    ],
    responseJsonSchema: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            factualFidelity: { type: "number" },
            completeness: { type: "number" },
            honestGapsDiscipline: { type: "number" },
            actionability: { type: "number" },
          },
          required: ["factualFidelity", "completeness", "honestGapsDiscipline", "actionability"],
        },
        passed: { type: "boolean" },
        notes: { type: "string" },
        followUpQuestions: { type: "array", items: { type: "string" } },
      },
      required: ["scores", "passed", "notes", "followUpQuestions"],
    },
    thinking: true,
    maxOutputTokens: 2000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  enforceCeiling(ctx);
  const parsed = parseCritique(result.text, ProfileCritiqueSchema);
  const evalScore = makeEvalScore(profileRubric, parsed.scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return { eval: evalScore, followUps: parsed.followUpQuestions || [] };
}

export const runOpsProfileReentrant = {
  async start(ctx: StageContext): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId) ??
      createStageExecutionState(ctx.stageId, ctx.stageDefinition.runnerKind, { phase: "start", round: 0 });
    
    const pending = pendingInteraction(ctx.project, state.pendingInteractionId);
    if (pending) return { status: "awaiting_input", state, interaction: pending };

    if (ctx.rejectionReason && state.step === 0 && !state.messages.some(m => typeof m.content === "string" && m.content.includes("rejection feedback"))) {
      state.messages.push({
        role: "user",
        content: `Reviewer rejected the previous draft with feedback: "${ctx.rejectionReason}". Let's adjust.`,
      });
      saveStageExecutionState(ctx.project, ctx.stageId, state);
      return awaitingQuestion(
        ctx,
        state,
        `Hi, I'm Lekha. The previous profile was rejected because: "${ctx.rejectionReason}". Let's start again to address this feedback. Can you clarify the required changes?`,
      );
    }

    if (!state.messages.length) {
      state.messages.push({
        role: "user",
        content: "Let's begin. What is the name of your business and what does it do?",
      });
      saveStageExecutionState(ctx.project, ctx.stageId, state);
      return awaitingQuestion(
        ctx,
        state,
        "Hi, I'm Lekha. I will help onboard your business operations. What is the name of your business and what does it do?",
      );
    }

    return awaitingQuestion(ctx, state, "Could you tell me more about your revenue streams, cost structures, or data sources?");
  },

  async resume(ctx: StageContext, response: InteractionResponse): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId);
    if (!state) throw new StageFailedClosedError("No onboarding state found.");

    if (state.pendingInteractionId !== response.interactionId) {
      throw new StageFailedClosedError("Interaction does not match the pending profile state.", {
        expected: state.pendingInteractionId,
        received: response.interactionId,
      });
    }

    const answer = response.text?.trim() || "";
    if (!answer) {
      throw new StageFailedClosedError("Profile interaction response was empty.", {
        interactionId: response.interactionId,
      });
    }

    state.pendingInteractionId = undefined;
    state.messages.push({ role: "user", content: answer });
    state.step++;
    const round = typeof state.data.round === "number" ? state.data.round : 0;
    state.data.round = round + 1;
    saveStageExecutionState(ctx.project, ctx.stageId, state);

    if (round + 1 > 3) {
      throw new StageFailedClosedError("Profile interview hit the round cap of 3 rounds without a successful profile.");
    }

    const result = await ctx.provider.generate({
      purpose: "generator",
      system: PROFILE_SYSTEM_PROMPT,
      messages: state.messages,
      tools: [profileSubmitTool],
      thinking: true,
      maxOutputTokens: 4000,
    });
    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);
    enforceCeiling(ctx);
    state.messages.push(result.message);

    const submit = result.toolCalls.find((c) => c.name === "submit_business_profile");
    if (submit) {
      const parsedArgs = BusinessProfileSchema.parse(submit.args);
      const critique = await critiqueProfile(ctx, parsedArgs);
      ctx.project.stages[ctx.stageId]!.evals.push(critique.eval);

      if (critique.eval.passed) {
        saveStageExecutionState(ctx.project, ctx.stageId, state);
        return {
          status: "awaiting_confirmation",
          state,
          artifacts: [
            {
              stage: ctx.stageId,
              kind: "business_profile",
              title: `Business Profile - ${parsedArgs.businessName}`,
              content: renderProfileMarkdown(parsedArgs),
              version: 1,
              createdAt: new Date().toISOString(),
              eval: critique.eval,
            },
          ],
        };
      } else if (critique.followUps.length > 0 && state.step < config.maxSteps) {
        const nextPrompt = critique.followUps.join("\n");
        return awaitingQuestion(ctx, state, nextPrompt);
      } else {
        throw new StageFailedClosedError("Profile stage did not pass rubric validation.");
      }
    }

    const nextPrompt = result.text || "Could you tell me more about your revenue and data sources?";
    return awaitingQuestion(ctx, state, nextPrompt);
  },
};

// ==========================================
// STAGE 2: KPI Design (Model flow)
// ==========================================

const KpiDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: z.string(),
  formula: z.string(),
  grain: z.enum(["day", "week", "month"]),
  directionOfGood: z.enum(["up", "down", "range"]),
  target: z.number().nullable(),
  minHistoryPeriods: z.number().int().min(4),
  source: z.enum(["catalog", "derived"]),
  rationale: z.string().nullable(),
});

const KpiSpecSchema = z.object({
  kpis: z.array(KpiDefSchema),
  anomalyConfig: z.object({
    sensitivity: z.enum(["low", "medium", "high"]),
    alertBudget: z.number().int().default(5),
    suppressionList: z.array(z.string()).default([]),
  }),
});

type KpiSpec = z.infer<typeof KpiSpecSchema>;

const KpiCritiqueSchema = z.object({
  scores: z.object({
    computability: z.number().min(1).max(5),
    relevance: z.number().min(1).max(5),
    formulaCorrectness: z.number().min(1).max(5),
    noVanity: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
});

function renderKpisMarkdown(spec: KpiSpec): string {
  const rows = spec.kpis
    .map(
      (k) =>
        `| ${k.id} | ${k.name} | ${k.definition} | \`${k.formula}\` | ${k.grain} | ${k.directionOfGood} | ${k.source} |`,
    )
    .join("\n");

  return `# KPI Specifications

Per-KPI definitions matching the canonical schemas:

| KPI ID | Name | Definition | Formula | Grain | Target direction | Source |
|---|---|---|---|---|---|---|
| ${rows} |

## Anomaly Configuration
- Sensitivity: ${spec.anomalyConfig.sensitivity}
- Alert Budget: ${spec.anomalyConfig.alertBudget}
- Suppression list: ${spec.anomalyConfig.suppressionList.join(", ") || "none"}

<!-- kpis_json: ${JSON.stringify(spec)} -->
`;
}

async function critiqueKpis(
  ctx: StageContext,
  spec: KpiSpec,
): Promise<EvalScore> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system: "You are the KPI spec critique agent. Score the KPI specification on computability (formulas use standard fields), relevance, formulaCorrectness, and noVanity. Score each 1-5, all must pass >= 4. Return JSON only.",
    messages: [
      { role: "user", content: JSON.stringify(spec, null, 2) },
    ],
    responseJsonSchema: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            computability: { type: "number" },
            relevance: { type: "number" },
            formulaCorrectness: { type: "number" },
            noVanity: { type: "number" },
          },
          required: ["computability", "relevance", "formulaCorrectness", "noVanity"],
        },
        passed: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["scores", "passed", "notes"],
    },
    thinking: true,
    maxOutputTokens: 2000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  enforceCeiling(ctx);
  const parsed = parseCritique(result.text, KpiCritiqueSchema);
  const evalScore = makeEvalScore(kpiDesignRubric, parsed.scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return evalScore;
}

export const runOpsKpiDesign: StageRunner = async (ctx) => {
  const profileArtifact = ctx.project.stages.profile?.artifacts.at(-1);
  if (!profileArtifact) throw new StageFailedClosedError("No business profile artifact found.");

  // Parse using hidden comment metadata
  const metaMatch = profileArtifact.content.match(/<!--\s*profile_meta:\s*model=([a-z-]+)/i);
  const modelType = metaMatch ? metaMatch[1]!.trim().toLowerCase() : "other";

  const catalogKpis = KPI_CATALOG[modelType] || KPI_CATALOG["other"]!;

  const messages: ModelMessage[] = [
    { role: "user", content: `Business profile:\n${profileArtifact.content}` },
  ];
  if (ctx.rejectionReason) {
    messages.push({
      role: "user",
      content: `The previous KPI design was rejected with feedback: "${ctx.rejectionReason}". Please revise to address this feedback.`,
    });
  }

  const result = await ctx.provider.generate({
    purpose: "generator",
    system: `You are Lekha, designing the KPI specification.
Review the business profile and standard catalog KPIs:
${JSON.stringify(catalogKpis)}

Verify if all catalog KPIs are computable from the profile's data sources.
If there are gaps, derive custom KPIs mapping to the customer's specific needs.
Formulas must use fields from standard tables: orders, order_lines, invoices, payments, expenses, subscription_events.
Return a structured KpiSpec JSON matching the schema.`,
    messages,
    responseJsonSchema: {
      type: "object",
      properties: {
        kpis: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              definition: { type: "string" },
              formula: { type: "string" },
              grain: { type: "string", enum: ["day", "week", "month"] },
              directionOfGood: { type: "string", enum: ["up", "down", "range"] },
              target: { type: ["number", "null"] },
              minHistoryPeriods: { type: "integer" },
              source: { type: "string", enum: ["catalog", "derived"] },
              rationale: { type: ["string", "null"] },
            },
            required: ["id", "name", "definition", "formula", "grain", "directionOfGood", "target", "minHistoryPeriods", "source", "rationale"],
          },
        },
        anomalyConfig: {
          type: "object",
          properties: {
            sensitivity: { type: "string", enum: ["low", "medium", "high"] },
            alertBudget: { type: "integer" },
            suppressionList: { type: "array", items: { type: "string" } },
          },
          required: ["sensitivity", "alertBudget", "suppressionList"],
        },
      },
      required: ["kpis", "anomalyConfig"],
    },
    thinking: true,
    maxOutputTokens: 4000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "generator", result);
  enforceCeiling(ctx);

  const spec = KpiSpecSchema.parse(JSON.parse(result.text));

  // Deterministic checks of formula computability
  for (const kpi of spec.kpis) {
    const valResult = validateFormula(kpi.formula);
    if (!valResult.valid) {
      throw new StageFailedClosedError(`KPI "${kpi.id}" has invalid formula "${kpi.formula}": ${valResult.error}`);
    }
  }

  const evalScore = await critiqueKpis(ctx, spec);
  ctx.project.stages[ctx.stageId]!.evals.push(evalScore);

  if (!evalScore.passed) {
    throw new StageFailedClosedError("KPI spec design did not pass rubric checks.");
  }

  return [
    {
      stage: ctx.stageId,
      kind: "kpi_spec",
      title: "KPI Specifications",
      content: renderKpisMarkdown(spec),
      version: 1,
      createdAt: new Date().toISOString(),
      eval: evalScore,
    },
  ];
};

// ==========================================
// STAGE 3: Source Binding (Reentrant)
// ==========================================

const SourceBindingSchema = z.object({
  connectors: z.array(z.object({
    id: z.string(),
    type: z.enum(["stripe", "shopify", "quickbooks", "xero", "csv"] as const),
    role: z.enum(["sales", "expenses", "subscriptions", "invoices"] as const),
    config: z.record(z.string(), z.any()),
  })),
  overlapRules: z.array(z.object({
    primarySource: z.string(),
    secondarySource: z.string(),
    action: z.enum(["dedup-by-id", "keep-both"] as const),
  })),
});

type SourceBinding = z.infer<typeof SourceBindingSchema>;

const SourceBindingCritiqueSchema = z.object({
  scores: z.object({
    reconciliation: z.number().min(1).max(5),
    computability: z.number().min(1).max(5),
    duplicateHandling: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
});

function renderSourceBindingMarkdown(b: SourceBinding): string {
  const conns = b.connectors.map((c) => `- **${c.id}** (${c.type}): role=${c.role}`).join("\n");
  const rules = b.overlapRules.map((r) => `- Dedup: ${r.primarySource} overrides ${r.secondarySource} (${r.action})`).join("\n");
  return `# Source Binding Configuration

## Connected Systems
${conns}

## Overlap Deduplication Rules
${rules || "No overlap rules registered."}

<!-- binding_json: ${JSON.stringify(b)} -->
`;
}

async function critiqueSourceBinding(
  ctx: StageContext,
  binding: SourceBinding,
): Promise<EvalScore> {
  const result = await ctx.provider.generate({
    purpose: "critic",
    system: "You are the Source Binding verifier. Score the configurations on reconciliation correctness, computability, duplicateHandling, and completeness. All must pass >= 4. Return JSON only.",
    messages: [
      { role: "user", content: JSON.stringify(binding, null, 2) },
    ],
    responseJsonSchema: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            reconciliation: { type: "number" },
            computability: { type: "number" },
            duplicateHandling: { type: "number" },
            completeness: { type: "number" },
          },
          required: ["reconciliation", "computability", "duplicateHandling", "completeness"],
        },
        passed: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["scores", "passed", "notes"],
    },
    thinking: true,
    maxOutputTokens: 2000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  enforceCeiling(ctx);
  const parsed = parseCritique(result.text, SourceBindingCritiqueSchema);
  const evalScore = makeEvalScore(sourceBindingRubric, parsed.scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return evalScore;
}

export const runOpsSourceBindingReentrant = {
  async start(ctx: StageContext): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId) ??
      createStageExecutionState(ctx.stageId, ctx.stageDefinition.runnerKind, { phase: "start" });
    const pending = pendingInteraction(ctx.project, state.pendingInteractionId);
    if (pending) return { status: "awaiting_input", state, interaction: pending };

    saveStageExecutionState(ctx.project, ctx.stageId, state);

    let prompt = "Please confirm the data source bindings. We will map Stripe to 'subscriptions' and QuickBooks to 'expenses', and establish overlap rules to deduplicate Shopify sales vs Stripe payouts. Do you approve? [y/N]";
    if (ctx.rejectionReason) {
      prompt = `Reviewer rejected the previous source bindings with feedback: "${ctx.rejectionReason}". Please review and confirm the bindings. Do you approve now? [y/N]`;
    }

    return awaitingQuestion(ctx, state, prompt);
  },

  async resume(ctx: StageContext, response: InteractionResponse): Promise<StageRunStep> {
    const state = loadStageExecutionState(ctx.project, ctx.stageId);
    if (!state) throw new StageFailedClosedError("No source binding state found.");

    if (state.pendingInteractionId !== response.interactionId) {
      throw new StageFailedClosedError("Interaction does not match the pending source binding state.", {
        expected: state.pendingInteractionId,
        received: response.interactionId,
      });
    }

    const answer = (response.text || "").toLowerCase().trim();
    if (!answer) {
      throw new StageFailedClosedError("Source binding interaction response was empty.", {
        interactionId: response.interactionId,
      });
    }

    state.pendingInteractionId = undefined;
    saveStageExecutionState(ctx.project, ctx.stageId, state);

    if (answer !== "y" && answer !== "yes") {
      throw new StageFailedClosedError("Source binding setup was rejected by the operator.");
    }

    // Load data sources from profile to build bindings dynamically
    const profileArtifact = ctx.project.stages.profile?.artifacts.at(-1);
    let dataSources: any[] = [];
    if (profileArtifact) {
      const jsonMatch = profileArtifact.content.match(/<!-- profile_json:\s*([\s\S]+?)\s*-->/);
      if (jsonMatch) {
        try {
          const profileData = JSON.parse(jsonMatch[1]!);
          dataSources = profileData.dataSources || [];
        } catch {
          // ignore
        }
      }
    }

    const connectors = dataSources.map((ds: any) => {
      const nameLower = ds.name.toLowerCase();
      let type: "stripe" | "shopify" | "quickbooks" | "xero" | "csv" = "csv";
      if (nameLower.includes("stripe")) type = "stripe";
      else if (nameLower.includes("shopify")) type = "shopify";
      else if (nameLower.includes("quickbooks") || nameLower.includes("qb")) type = "quickbooks";
      else if (nameLower.includes("xero")) type = "xero";

      let role: "sales" | "expenses" | "subscriptions" | "invoices" = "sales";
      if (type === "stripe") role = "subscriptions";
      else if (type === "quickbooks" || type === "xero") role = "expenses";
      else if (type === "shopify") role = "sales";

      return {
        id: `${type}-conn`,
        type,
        role,
        config: {},
      };
    });

    const overlapRules: any[] = [];
    const shopifyConn = connectors.find(c => c.type === "shopify");
    const stripeConn = connectors.find(c => c.type === "stripe");
    if (shopifyConn && stripeConn) {
      overlapRules.push({
        primarySource: shopifyConn.id,
        secondarySource: stripeConn.id,
        action: "dedup-by-id",
      });
    }

    const defaultBinding: SourceBinding = {
      connectors: connectors.length ? connectors : [
        { id: "stripe-sub", type: "stripe", role: "subscriptions", config: {} },
        { id: "qb-expense", type: "quickbooks", role: "expenses", config: {} },
        { id: "shopify-sales", type: "shopify", role: "sales", config: {} },
      ],
      overlapRules: overlapRules.length ? overlapRules : [
        { primarySource: "shopify-sales", secondarySource: "stripe-sub", action: "dedup-by-id" },
      ],
    };

    const evalScore = await critiqueSourceBinding(ctx, defaultBinding);
    ctx.project.stages[ctx.stageId]!.evals.push(evalScore);

    if (!evalScore.passed) {
      throw new StageFailedClosedError("Source binding specifications did not pass checks.");
    }

    return {
      status: "awaiting_confirmation",
      state,
      artifacts: [
        {
          stage: ctx.stageId,
          kind: "source_binding",
          title: "Source Bindings",
          content: renderSourceBindingMarkdown(defaultBinding),
          version: 1,
          createdAt: new Date().toISOString(),
          eval: evalScore,
        },
      ],
    };
  },
};

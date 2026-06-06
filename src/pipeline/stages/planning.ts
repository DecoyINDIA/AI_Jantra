import { z } from "zod";

import { config } from "../../config.js";
import { runArtifactOutputChecks } from "../../policy.js";
import { makeEvalScore, runEvaluatorLoop, type Critique } from "../../runtime/evaluator.js";
import { SchemaValidationError, StageFailedClosedError } from "../../runtime/errors.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import { checkCrossDocumentConsistency } from "../planning/consistency.js";
import { planningRubric } from "../planning/rubric.js";
import {
  planningCritiqueSchema,
  planningDocumentSchema,
  type PlanningDocument,
} from "../planning/schemas.js";
import type { Artifact, ArtifactKind, EvalScore, StageContext } from "../types.js";

type PlanningKind = "prd" | "trd" | "build_plan";

const PLANNING_DOCUMENT_OUTPUT_TOKENS = 7000;
const PLANNING_CRITIQUE_OUTPUT_TOKENS = 1800;
const PLANNING_REFINE_OUTPUT_TOKENS = 7000;
const CONCISION_DIRECTIVE =
  "Be specific and concise. No filler, no preamble, do not restate the prompt. Prefer structured bullets over prose. Every sentence must add information.";

function latestArtifact(ctx: StageContext, kind: ArtifactKind): Artifact {
  const artifact = Object.values(ctx.project.stages)
    .flatMap((stage) => stage.artifacts)
    .filter((candidate) => candidate.kind === kind)
    .at(-1);
  if (!artifact) {
    throw new StageFailedClosedError(`Planning requires artifact ${kind}.`, {
      projectId: ctx.project.id,
      clientId: ctx.project.clientId,
    });
  }
  return artifact;
}

function parseJson<T>(schema: z.ZodType<T>, text: string, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SchemaValidationError(`${label} returned invalid JSON.`, {
      error: err instanceof Error ? err.message : String(err),
      text,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SchemaValidationError(`${label} failed schema validation.`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function documentPrompt(
  kind: PlanningKind,
  idea: Artifact,
  research: Artifact,
  prior: PlanningDocument | null,
  prdRequirements: PlanningDocument["requirements"],
): string {
  const docName =
    kind === "prd" ? "PRD" : kind === "trd" ? "TRD" : "phased build plan";
  const priorText = prior ? `\n\nPrior document to build on:\n${renderDocument(prior)}` : "";
  const requirementInstruction =
    kind === "prd"
      ? "\n- Include a top-level requirements array. Use stable IDs exactly as req-1, req-2, req-3, in sequence."
      : `\n- Reference the PRD requirement IDs each section addresses in requirementIds. Cover every ID: ${prdRequirements
          .map((requirement) => requirement.id)
          .join(", ")}.`;
  return `Create a ${docName} for this product idea.

Confirmed idea:
${idea.content}

Use the confirmed research report in context for grounding.${priorText}

Requirements:
- Be specific to the idea and research.
- Include goals, non-goals, risks, acceptance criteria, and open questions where relevant.
- When using market facts, refer to source IDs from the research report.${requirementInstruction}
- Return only JSON matching the schema.`;
}

async function generateDocument(
  ctx: StageContext,
  kind: PlanningKind,
  idea: Artifact,
  research: Artifact,
  prior: PlanningDocument | null,
  prdRequirements: PlanningDocument["requirements"],
  purpose: string,
): Promise<PlanningDocument> {
  const result = await ctx.provider.generate({
    purpose,
    cacheKey: `${ctx.project.id}:research_report:v${research.version}`,
    cacheMessages: [
      {
        role: "user",
        content: `Confirmed research report:\n${research.content.slice(0, 30_000)}`,
      },
    ],
    system: `You are the Planning generator. Produce a build-ready planning document that is grounded in the provided research. Return only JSON.
${CONCISION_DIRECTIVE}`,
    messages: [
      { role: "user", content: documentPrompt(kind, idea, research, prior, prdRequirements) },
    ],
    responseJsonSchema: z.toJSONSchema(planningDocumentSchema),
    thinking: true,
    temperature: 0.1,
    maxOutputTokens: PLANNING_DOCUMENT_OUTPUT_TOKENS,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, purpose, result);
  return parseJson(planningDocumentSchema, result.text, `${kind} generation`);
}

async function critiqueDocument(
  ctx: StageContext,
  kind: PlanningKind,
  doc: PlanningDocument,
): Promise<Critique<PlanningDocument>> {
  const result = await ctx.provider.generate({
    purpose: `${kind}_critic`,
    system: `You are the Planning critic. Score completeness, internal consistency, grounding, technical soundness, and actionability. Return only JSON.
${CONCISION_DIRECTIVE}`,
    messages: [{ role: "user", content: renderDocument(doc) }],
    responseJsonSchema: z.toJSONSchema(planningCritiqueSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: PLANNING_CRITIQUE_OUTPUT_TOKENS,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, `${kind}_critic`, result);
  const parsed = parseJson(planningCritiqueSchema, result.text, `${kind} critique`);
  const evalScore = makeEvalScore(planningRubric, parsed.scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return { eval: evalScore, feedback: parsed.notes, draft: doc };
}

async function refineDocument(
  ctx: StageContext,
  kind: PlanningKind,
  draft: PlanningDocument,
  critique: Critique<PlanningDocument>,
  idea: Artifact,
  research: Artifact,
  prior: PlanningDocument | null,
  prdRequirements: PlanningDocument["requirements"],
): Promise<PlanningDocument> {
  const priorText = prior ? `\n\nPrior planning context:\n${renderDocument(prior)}` : "";
  const requirementContext = prdRequirements.length
    ? `\n\nPRD requirement IDs to preserve and cover:\n${prdRequirements
        .map(
          (requirement) =>
            `- ${requirement.id}: ${requirement.text} Acceptance: ${requirement.acceptanceCriteria.join(
              "; ",
            )}`,
        )
        .join("\n")}`
    : "";
  const result = await ctx.provider.generate({
    purpose: `${kind}_refine`,
    cacheKey: `${ctx.project.id}:research_report:v${research.version}`,
    cacheMessages: [
      {
        role: "user",
        content: `Confirmed research report:\n${research.content.slice(0, 30_000)}`,
      },
    ],
    system: `You are the Planning refiner. Improve the document to satisfy the critic while preserving research grounding. Return only JSON.
${CONCISION_DIRECTIVE}`,
    messages: [
      {
        role: "user",
        content: `Document kind: ${kind}\n\nConfirmed idea:\n${idea.content}\n\nUse the confirmed research report in context.${priorText}${requirementContext}\n\nCritique:\n${critique.feedback}\n\nDraft:\n${renderDocument(
          draft,
        )}`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(planningDocumentSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: PLANNING_REFINE_OUTPUT_TOKENS,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, `${kind}_refine`, result);
  return parseJson(planningDocumentSchema, result.text, `${kind} refinement`);
}

function renderDocument(doc: PlanningDocument): string {
  const requirements = doc.requirements.length
    ? `\n\n## Requirements\n${doc.requirements
        .map(
          (requirement) =>
            `- ${requirement.id}: ${requirement.text}\n  Acceptance: ${requirement.acceptanceCriteria.join(
              "; ",
            )}`,
        )
        .join("\n")}`
    : "";
  const sections = doc.sections
    .map((section) => {
      const sources = section.sourceIds.length
        ? `\n\nSources: ${section.sourceIds.map((id) => `[${id}]`).join(" ")}`
        : "";
      const requirementIds = section.requirementIds.length
        ? `\n\nRequirement IDs: ${section.requirementIds.join(", ")}`
        : "";
      return `## ${section.heading}\n${section.body}${sources}${requirementIds}`;
    })
    .join("\n\n");
  const risks = doc.risks.length
    ? doc.risks.map((risk) => `- ${risk}`).join("\n")
    : "- No additional risks listed.";
  const openQuestions = doc.openQuestions.length
    ? doc.openQuestions.map((question) => `- ${question}`).join("\n")
    : "- None.";
  return `# ${doc.title}
${requirements}

${sections}

## Risks
${risks}

## Open questions
${openQuestions}
`;
}

async function buildDocument(
  ctx: StageContext,
  kind: PlanningKind,
  idea: Artifact,
  research: Artifact,
  prior: PlanningDocument | null,
  prdRequirements: PlanningDocument["requirements"] = [],
): Promise<{ doc: PlanningDocument; eval: EvalScore }> {
  const result = await runEvaluatorLoop({
    audit: ctx.audit,
    project: ctx.project,
    stage: ctx.stageId,
    provider: ctx.provider,
    rubric: planningRubric,
    maxRounds: config.maxEvalRounds,
    generate: () =>
      generateDocument(ctx, kind, idea, research, prior, prdRequirements, `${kind}_generator`),
    critique: (draft) => critiqueDocument(ctx, kind, draft),
    refine: (draft, critique) =>
      refineDocument(ctx, kind, draft, critique, idea, research, prior, prdRequirements),
  });
  return { doc: result.draft, eval: result.eval };
}

export async function runPlanning(ctx: StageContext): Promise<Artifact[]> {
  const idea = latestArtifact(ctx, "idea_summary");
  const research = latestArtifact(ctx, "research_report");

  const prd = await buildDocument(ctx, "prd", idea, research, null);
  const trd = await buildDocument(ctx, "trd", idea, research, prd.doc, prd.doc.requirements);
  const buildPlan = await buildDocument(
    ctx,
    "build_plan",
    idea,
    research,
    trd.doc,
    prd.doc.requirements,
  );

  const consistency = checkCrossDocumentConsistency(prd.doc, trd.doc, buildPlan.doc);
  if (!consistency.passed) {
    ctx.audit.record("guardrail_block", {
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
      stage: ctx.stageId,
      flags: consistency.issues,
      reason: "Cross-document consistency check failed.",
    });
    throw new StageFailedClosedError("Planning documents failed consistency checks.", {
      issues: consistency.issues,
    });
  }

  const artifacts: Artifact[] = [
    {
      stage: ctx.stageId,
      kind: "prd",
      title: prd.doc.title,
      content: renderDocument(prd.doc),
      version: 1,
      createdAt: new Date().toISOString(),
      eval: prd.eval,
    },
    {
      stage: ctx.stageId,
      kind: "trd",
      title: trd.doc.title,
      content: renderDocument(trd.doc),
      version: 1,
      createdAt: new Date().toISOString(),
      eval: trd.eval,
    },
    {
      stage: ctx.stageId,
      kind: "build_plan",
      title: buildPlan.doc.title,
      content: renderDocument(buildPlan.doc),
      version: 1,
      createdAt: new Date().toISOString(),
      eval: buildPlan.eval,
    },
  ];

  for (const artifact of artifacts) {
    const outputCheck = runArtifactOutputChecks(artifact);
    if (!outputCheck.allowed) {
      ctx.audit.record("guardrail_block", {
        clientId: ctx.project.clientId,
        projectId: ctx.project.id,
        stage: ctx.stageId,
        artifactKind: artifact.kind,
        flags: outputCheck.flags,
        reason: outputCheck.reason,
      });
      throw new StageFailedClosedError("Planning artifact failed output checks.", {
        artifactKind: artifact.kind,
        outputCheck,
      });
    }
  }

  return artifacts;
}

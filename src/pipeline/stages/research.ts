import { z } from "zod";

import { config } from "../../config.js";
import type { GroundingCitation } from "../../model/provider.js";
import { runArtifactOutputChecks } from "../../policy.js";
import { makeEvalScore, runEvaluatorLoop, type Critique } from "../../runtime/evaluator.js";
import { SchemaValidationError, StageFailedClosedError } from "../../runtime/errors.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import { sourceAppendix, verifyClaims } from "../research/citationVerifier.js";
import { researchRubric } from "../research/rubric.js";
import {
  researchCritiqueSchema,
  researchPlanSchema,
  sectionClaimsSchema,
  type ResearchPlan,
} from "../research/schemas.js";
import { registerSource } from "../research/sourceRegistry.js";
import {
  dedupeCitationCandidates,
  rankAndCapCitationCandidates,
  type CitationCandidate,
} from "../research/sourceSelection.js";
import { fetchPage } from "../research/webFetch.js";
import type { Artifact, Claim, EvalScore, Source, StageContext } from "../types.js";

interface SynthesizedSection {
  title: string;
  summary: string;
  claims: Claim[];
  risks: string[];
}

function latestIdeaSummary(ctx: StageContext): Artifact {
  const artifact = Object.values(ctx.project.stages)
    .flatMap((stage) => stage.artifacts)
    .filter((candidate) => candidate.kind === "idea_summary")
    .at(-1);
  if (!artifact || artifact.kind !== "idea_summary") {
    throw new StageFailedClosedError("Research requires a confirmed idea summary.", {
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

async function planResearch(ctx: StageContext, idea: Artifact): Promise<ResearchPlan> {
  const result = await ctx.provider.generate({
    purpose: "planner",
    system:
      "You are a research planner. Break the idea into market research sections. For each section, provide 2 to 4 concrete search queries that cover primary sources, competitors, risks, and demand signals. Return only JSON.",
    messages: [{ role: "user", content: idea.content }],
    responseJsonSchema: z.toJSONSchema(researchPlanSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: 3000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "planner", result);
  return parseJson(researchPlanSchema, result.text, "Research plan");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await run(value);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

async function groundedSearch(
  ctx: StageContext,
  section: ResearchPlan["sections"][number],
  query: string,
): Promise<{ sectionTitle: string; query: string; citations: GroundingCitation[] }> {
  const idea = latestIdeaSummary(ctx);
  const result = await ctx.provider.generate({
    purpose: "grounded_search",
    cacheKey: `${ctx.project.id}:idea_summary:v${idea.version}`,
    cacheMessages: [
      {
        role: "user",
        content: `Confirmed idea summary:\n${idea.content}`,
      },
    ],
    system:
      "You are a market researcher. Use Google Search grounding. Summarize only what the search results support, and include risks or counter-evidence when available.",
    messages: [
      {
        role: "user",
        content: `Use the confirmed idea summary in context.\n\nResearch section: ${section.title}\nQuestion: ${section.question}\nSearch query: ${query}`,
      },
    ],
    grounding: true,
    thinking: true,
    maxOutputTokens: 4000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "grounded_search", result);
  return { sectionTitle: section.title, query, citations: result.citations };
}

async function fetchSelectedSources(
  ctx: StageContext,
  candidates: CitationCandidate[],
): Promise<{ sourceByUrl: Map<string, Source>; sourceTexts: Map<string, string> }> {
  const sourceByUrl = new Map<string, Source>();
  const sourceTexts = new Map<string, string>();

  await mapWithConcurrency(candidates, config.researchConcurrency, async (candidate) => {
    try {
      const page = await fetchPage(candidate.uri, candidate.title);
      const source = registerSource(ctx.project, ctx.audit, page);
      sourceByUrl.set(candidate.normalizedUrl, source);
      sourceTexts.set(source.id, page.sanitized);
      if (page.promptInjectionFlags.length) {
        ctx.audit.record("guardrail_block", {
          clientId: ctx.project.clientId,
          projectId: ctx.project.id,
          stage: ctx.stageId,
          sourceId: source.id,
          flags: page.promptInjectionFlags,
          reason: "Untrusted source content was neutralized.",
        });
      }
    } catch (err) {
      ctx.audit.record("citation_rejected", {
        clientId: ctx.project.clientId,
        projectId: ctx.project.id,
        stage: ctx.stageId,
        uri: candidate.uri,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { sourceByUrl, sourceTexts };
}

function sectionSources(
  sectionTitle: string,
  candidates: CitationCandidate[],
  sourceByUrl: Map<string, Source>,
): Source[] {
  const byId = new Map<string, Source>();
  for (const candidate of candidates) {
    if (!candidate.sectionTitles.includes(sectionTitle)) continue;
    const source = sourceByUrl.get(candidate.normalizedUrl);
    if (source) byId.set(source.id, source);
  }
  return [...byId.values()].sort((a, b) => b.qualityScore - a.qualityScore);
}

async function synthesizeSection(
  ctx: StageContext,
  sectionTitle: string,
  sources: Source[],
  sourceTexts: Map<string, string>,
): Promise<SynthesizedSection> {
  if (!sources.length) {
    return {
      title: sectionTitle,
      summary: "Jantra could not retrieve enough sources for this section.",
      claims: [],
      risks: ["Insufficient retrievable sources."],
    };
  }

  const sourceMaterial = sources
    .map((source) => {
      const text = sourceTexts.get(source.id) ?? "";
      return `[${source.id}] ${source.title}\n${source.url}\n${text.slice(0, 5000)}`;
    })
    .join("\n\n");

  const result = await ctx.provider.generate({
    purpose: "section_synthesis",
    system:
      "You synthesize market research from registered source excerpts. Every factual market claim must cite one or more provided source IDs and one verbatim quote copied from each cited source excerpt. Do not cite URLs or sources not provided, and never invent quotes. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `Section: ${sectionTitle}\n\nRegistered source excerpts:\n${sourceMaterial}`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(sectionClaimsSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: 5000,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "section_synthesis", result);
  const parsed = parseJson(sectionClaimsSchema, result.text, "Research section synthesis");
  const claims = verifyClaims(
    ctx.project,
    ctx.audit,
    parsed.claims.map((claim) => ({
      text: claim.text,
      citations: claim.citations,
      sourceIds: claim.citations.map((citation) => citation.sourceId),
      verified: false,
      support: "unverified",
    })),
    sourceTexts,
  );
  return { title: sectionTitle, summary: parsed.summary, claims, risks: parsed.risks };
}

function renderReport(
  idea: Artifact,
  sections: SynthesizedSection[],
  sources: Source[],
): string {
  const body = sections
    .map((section) => {
      const verified = section.claims.filter((claim) => claim.verified);
      const unverified = section.claims.filter((claim) => !claim.verified);
      const claims = verified.length
        ? verified
            .map((claim) => `- ${claim.text} ${claim.sourceIds.map((id) => `[${id}]`).join(" ")}`)
            .join("\n")
        : "- Jantra abstained from market claims for this section because citations could not be verified.";
      const risks = section.risks.length
        ? section.risks.map((risk) => `- ${risk}`).join("\n")
        : "- No distinct section risks found in the retrieved sources.";
      const rejected = unverified.length
        ? `\n\n### Unverified leads\n${unverified.map((claim) => `- ${claim.text}`).join("\n")}`
        : "";
      return `## ${section.title}

${section.summary}

### Verified claims
${claims}

### Risks and caveats
${risks}${rejected}`;
    })
    .join("\n\n");

  return `# Market research report - ${idea.title}

## Basis
This report is based on the confirmed idea summary from Intake and on sources explicitly retrieved, hashed, and registered by Jantra.

${body}

## Sources
${sourceAppendix(sources)}
`;
}

async function critiqueReport(
  ctx: StageContext,
  report: string,
  claims: Claim[],
): Promise<Critique<string>> {
  const deterministic = {
    citationAccuracy: claims.every((claim) => claim.verified) && claims.length > 0 ? 5 : 2,
  };
  const result = await ctx.provider.generate({
    purpose: "critic",
    system:
      "You are the Research verifier. Score the report for factual accuracy, citation accuracy, completeness, source quality, and balance. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `Report:\n${report}\n\nVerified claim count: ${
          claims.filter((claim) => claim.verified).length
        }\nTotal claim count: ${claims.length}`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(researchCritiqueSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: 2500,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "critic", result);
  const parsed = parseJson(researchCritiqueSchema, result.text, "Research critique");
  const scores = {
    ...parsed.scores,
    citationAccuracy: Math.min(parsed.scores.citationAccuracy, deterministic.citationAccuracy),
  };
  const evalScore = makeEvalScore(researchRubric, scores, parsed.notes);
  evalScore.passed = evalScore.passed && parsed.passed;
  return { eval: evalScore, feedback: parsed.notes, draft: report };
}

async function refineReport(
  ctx: StageContext,
  report: string,
  critique: Critique<string>,
  claims: Claim[],
): Promise<string> {
  const verifiedClaims = claims
    .filter((claim) => claim.verified)
    .map((claim) => {
      const citations = claim.citations
        .map((citation) => `[${citation.sourceId}] "${citation.quote}"`)
        .join("; ");
      return `- ${claim.text} ${citations}`;
    })
    .join("\n");
  const result = await ctx.provider.generate({
    purpose: "report_refine",
    system:
      "You are the Research refiner. Improve clarity, balance, and completeness using only the verified claims and quotes provided. Do not add new market facts, citations, URLs, or source IDs. Return markdown only.",
    messages: [
      {
        role: "user",
        content: `Critique:\n${critique.feedback}\n\nVerified claims and source quotes:\n${verifiedClaims}\n\nDraft report:\n${report}`,
      },
    ],
    thinking: true,
    temperature: 0,
    maxOutputTokens: config.maxOutputTokens,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "report_refine", result);
  const refined = result.text.trim();
  if (!refined) {
    throw new StageFailedClosedError("Research refiner returned an empty report.", {
      projectId: ctx.project.id,
      clientId: ctx.project.clientId,
    });
  }
  return refined;
}

export async function runResearch(ctx: StageContext): Promise<Artifact[]> {
  const idea = latestIdeaSummary(ctx);
  const plan = await planResearch(ctx, idea);

  const searchJobs = plan.sections.flatMap((section) =>
    section.searchQueries.map((query) => ({ section, query })),
  );
  const searched = await mapWithConcurrency(
    searchJobs,
    config.researchConcurrency,
    (job) => groundedSearch(ctx, job.section, job.query),
  );

  const deduped = dedupeCitationCandidates(
    searched.flatMap((result) =>
      result.citations.map((citation) => ({
        uri: citation.uri,
        title: citation.title,
        sectionTitle: result.sectionTitle,
      })),
    ),
  );
  const capped = rankAndCapCitationCandidates(deduped, config.maxSources);
  if (capped.dropped.length) {
    ctx.audit.record("source_cap_applied", {
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
      stage: ctx.stageId,
      maxSources: config.maxSources,
      selected: capped.selected.length,
      dropped: capped.dropped.length,
      droppedUrls: capped.dropped.map((candidate) => candidate.uri),
    });
  }

  const fetched = await fetchSelectedSources(ctx, capped.selected);
  const sectionInputs = plan.sections.map((section) => {
    const sources = sectionSources(section.title, capped.selected, fetched.sourceByUrl);
    const sourceTexts = new Map(
      sources
        .map((source) => [source.id, fetched.sourceTexts.get(source.id)] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
    );
    return { sectionTitle: section.title, sources, sourceTexts };
  });

  const synthesized = await mapWithConcurrency(
    sectionInputs,
    config.synthesisConcurrency,
    (section) => synthesizeSection(ctx, section.sectionTitle, section.sources, section.sourceTexts),
  );

  const claims = synthesized.flatMap((section) => section.claims);
  ctx.project.claims.push(...claims);

  const evaluated = await runEvaluatorLoop({
    audit: ctx.audit,
    project: ctx.project,
    stage: ctx.stageId,
    provider: ctx.provider,
    rubric: researchRubric,
    maxRounds: config.maxEvalRounds,
    generate: async () => renderReport(idea, synthesized, ctx.project.sources),
    critique: (draft) => critiqueReport(ctx, draft, claims),
    refine: (draft, critique) => refineReport(ctx, draft, critique, claims),
  });

  const artifact: Artifact = {
    stage: ctx.stageId,
    kind: "research_report",
    title: `Market research - ${idea.title}`,
    content: evaluated.draft,
    version: 1,
    createdAt: new Date().toISOString(),
    eval: evaluated.eval,
  };

  const outputCheck = runArtifactOutputChecks(artifact, claims);
  if (!outputCheck.allowed || !evaluated.eval.passed) {
    ctx.audit.record("guardrail_block", {
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
        stage: ctx.stageId,
      flags: outputCheck.flags,
      reason: outputCheck.reason,
      eval: evaluated.eval,
    });
    throw new StageFailedClosedError("Research report did not pass verification.", {
      eval: evaluated.eval,
      outputCheck,
    });
  }

  return [artifact];
}

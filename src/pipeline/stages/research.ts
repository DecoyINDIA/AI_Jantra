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
  founderAnchorSchema,
  researchCritiqueSchema,
  researchPlanSchema,
  sectionClaimsSchema,
  viabilitySummarySchema,
  type EvidenceSectionKey,
  type FounderAnchorFit,
  type ResearchPlan,
  type ViabilitySummary,
} from "../research/schemas.js";
import { BUILD_PHILOSOPHY, FOUNDER_PHILOSOPHY } from "./intake.js";
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

interface SectionDef {
  key: EvidenceSectionKey;
  title: string;
  question: string;
  guidance: string;
}

/**
 * The five evidence sections, always planned regardless of idea type
 * (brief 6.1). Founder-Anchor Fit is the sixth required section and is handled
 * separately as an interpretive synthesis. The Viability Assessment guidance is
 * enriched with the market-research practices the founder asked us to fold in:
 * bottom-up market sizing, Porter's Five Forces, and SaaS benchmark bands.
 */
const EVIDENCE_SECTIONS: SectionDef[] = [
  {
    key: "market_demand",
    title: "Market Demand",
    question:
      "Is there evidence of real, active demand? Look for search volume, community signals, and survey data.",
    guidance:
      "Surface concrete demand signals: search interest, community complaints, waitlists, and survey or report data. Distinguish stated interest from evidence of spend.",
  },
  {
    key: "competitive_landscape",
    title: "Competitive Landscape",
    question:
      "Who is solving this already? Funded competitors, incumbents, and free alternatives.",
    guidance:
      "Map direct competitors, incumbents, and free or manual alternatives. Note positioning, pricing where visible, and where each is weak.",
  },
  {
    key: "viability_assessment",
    title: "Viability Assessment",
    question:
      "Is this economically sustainable? Unit economics signals, pricing norms, and CAC benchmarks.",
    guidance:
      "Size the opportunity bottom-up first (number of target customers multiplied by a realistic annual revenue per customer), then sanity-check against any top-down figures. Read industry structure through Porter's Five Forces: barriers to entry, buyer and supplier power, threat of substitutes, and rivalry. Where the model is SaaS-like, compare against benchmark bands rather than fixed cutoffs: gross margin around 60 to 70 percent or higher, LTV to CAC of 3 or more, CAC payback of 12 to 24 months, and churn under roughly 5 percent monthly for SMB and under 2 percent for enterprise. Flag when pricing norms or unit economics look structurally unsustainable.",
  },
  {
    key: "regulatory_legal",
    title: "Regulatory and Legal",
    question:
      "Are there compliance requirements, licensing, or legal risks in this space?",
    guidance:
      "Identify licensing, data-protection, sector-specific compliance, and liability risks. Note where requirements vary by geography.",
  },
  {
    key: "technical_feasibility",
    title: "Technical Feasibility",
    question:
      "Can this be built with available tools? Are there major infrastructure or API dependencies?",
    guidance:
      "Assess whether the core can be built with available tools and APIs. Flag heavy infrastructure, data, model, or third-party dependencies and their limits.",
  },
];

interface Anchors {
  buildPhilosophy: string;
  founderPhilosophy: string;
}

/** Read the build/founder philosophy anchors embedded in the idea summary. */
function readAnchors(idea: Artifact): Anchors {
  const match = idea.content.match(
    /anchors:\s*build_philosophy=([a-z_]+);\s*founder_philosophy=([a-z_]+)/i,
  );
  return {
    buildPhilosophy: match?.[1] ?? "unspecified",
    founderPhilosophy: match?.[2] ?? "unspecified",
  };
}

function anchorLegend(anchors: Anchors): string {
  const build =
    BUILD_PHILOSOPHY[anchors.buildPhilosophy as keyof typeof BUILD_PHILOSOPHY] ??
    "unspecified";
  const founder =
    FOUNDER_PHILOSOPHY[anchors.founderPhilosophy as keyof typeof FOUNDER_PHILOSOPHY] ??
    "unspecified";
  return `build_philosophy: ${anchors.buildPhilosophy} (${build})\nfounder_philosophy: ${anchors.founderPhilosophy} (${founder})`;
}

function sectionDigest(sections: SynthesizedSection[]): string {
  return sections
    .map((section) => {
      const claims = section.claims
        .filter((claim) => claim.verified)
        .map((claim) => `  - ${claim.text}`)
        .join("\n");
      const risks = section.risks.map((risk) => `  - ${risk}`).join("\n");
      return `## ${section.title}\n${section.summary}\nVerified findings:\n${
        claims || "  - (none verified)"
      }\nRisks:\n${risks || "  - (none noted)"}`;
    })
    .join("\n\n");
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

async function planResearch(
  ctx: StageContext,
  idea: Artifact,
  anchors: Anchors,
): Promise<ResearchPlan> {
  const sectionBrief = EVIDENCE_SECTIONS.map(
    (section) => `${section.key} (${section.title}): ${section.question}`,
  ).join("\n");
  const result = await ctx.provider.generate({
    purpose: "planner",
    system:
      "You are a research planner. You must produce 2 to 4 concrete search queries for each of the five fixed research sections. Queries must be specific to the idea and grounded in primary sources, competitors, risks, demand, and economics. Weight queries toward what the founder's build_philosophy and founder_philosophy make most relevant, but always cover every section. Return only JSON keyed by the section keys.",
    messages: [
      {
        role: "user",
        content: `Idea summary:\n${idea.content}\n\nFounder anchors:\n${anchorLegend(
          anchors,
        )}\n\nFixed sections to plan queries for:\n${sectionBrief}`,
      },
    ],
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
  section: SectionDef,
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
  section: SectionDef,
  sources: Source[],
  sourceTexts: Map<string, string>,
): Promise<SynthesizedSection> {
  if (!sources.length) {
    return {
      title: section.title,
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
        content: `Section: ${section.title}\nQuestion: ${section.question}\nHow to approach this section: ${section.guidance}\n\nRegistered source excerpts:\n${sourceMaterial}`,
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
  return { title: section.title, summary: parsed.summary, claims, risks: parsed.risks };
}

/**
 * Founder-Anchor Fit (brief 6.1): interpret how the gathered evidence aligns
 * with the founder's stated anchors. No new market facts, so no citations.
 */
async function synthesizeFounderAnchorFit(
  ctx: StageContext,
  anchors: Anchors,
  sections: SynthesizedSection[],
): Promise<FounderAnchorFit> {
  const result = await ctx.provider.generate({
    purpose: "founder_anchor_synthesis",
    system:
      "You assess how well the market evidence aligns with the founder's stated build_philosophy and founder_philosophy. Use only the findings provided. Note where evidence supports the chosen direction and where it creates tension. Do not invent market facts, do not cite sources, and do not recommend a go or no-go decision. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `Founder anchors:\n${anchorLegend(anchors)}\n\nResearch findings:\n${sectionDigest(
          sections,
        )}`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(founderAnchorSchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: 2500,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "founder_anchor_synthesis", result);
  return parseJson(founderAnchorSchema, result.text, "Founder-anchor fit");
}

/**
 * Viability Summary surfaced at the human gate (brief 6.2): red flags,
 * opportunities, and an economic-sustainability note, framed neutrally. The
 * agent presents the data and never makes a go/no-go call.
 */
async function summarizeViability(
  ctx: StageContext,
  anchors: Anchors,
  sections: SynthesizedSection[],
): Promise<ViabilitySummary> {
  const result = await ctx.provider.generate({
    purpose: "viability_summary",
    system:
      "You produce a neutral viability summary for a human gate. List key red flags (saturation, funded competitors, no demand evidence, unsustainable economics) and key opportunities (underserved niche, weak existing solutions, growing demand), and write one short note on economic sustainability grounded in the pricing and unit-economics findings. Present the data only. Never recommend whether to proceed, never say go or no-go, and never tell the founder what to do. Use only the findings provided. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `Founder anchors:\n${anchorLegend(anchors)}\n\nResearch findings:\n${sectionDigest(
          sections,
        )}`,
      },
    ],
    responseJsonSchema: z.toJSONSchema(viabilitySummarySchema),
    thinking: true,
    temperature: 0,
    maxOutputTokens: 2500,
  });
  trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "viability_summary", result);
  return parseJson(viabilitySummarySchema, result.text, "Viability summary");
}

function renderViabilitySummary(viability: ViabilitySummary): string {
  const bullets = (items: string[], empty: string) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
  return `## Viability Summary

This summary presents what the research found so the founder can decide how to proceed. It is not a recommendation.

### Red flags
${bullets(viability.redFlags, "No major red flags surfaced in the retrieved sources.")}

### Opportunities
${bullets(viability.opportunities, "No distinct opportunities surfaced in the retrieved sources.")}

### Economic sustainability
${viability.economicsNote}`;
}

function renderFounderAnchorFit(anchorFit: FounderAnchorFit): string {
  const bullets = (items: string[], empty: string) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
  return `## Founder-Anchor Fit

${anchorFit.summary}

### Where the evidence aligns
${bullets(anchorFit.alignmentPoints, "No clear alignment points found.")}

### Where there is tension
${bullets(anchorFit.tensions, "No clear tensions found.")}`;
}

function renderReport(
  idea: Artifact,
  viability: ViabilitySummary,
  sections: SynthesizedSection[],
  anchorFit: FounderAnchorFit,
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

${renderViabilitySummary(viability)}

${body}

${renderFounderAnchorFit(anchorFit)}

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
      "You are the Research refiner. Improve clarity, balance, and completeness using only the verified claims and quotes provided. Do not add new market facts, citations, URLs, or source IDs. Preserve every section, including the Viability Summary and the Founder-Anchor Fit. Keep the framing neutral and never add a go or no-go recommendation. Return markdown only.",
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
  const anchors = readAnchors(idea);
  const plan = await planResearch(ctx, idea, anchors);

  const searchJobs = EVIDENCE_SECTIONS.flatMap((section) =>
    plan[section.key].map((query) => ({ section, query })),
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
  const sectionInputs = EVIDENCE_SECTIONS.map((section) => {
    const sources = sectionSources(section.title, capped.selected, fetched.sourceByUrl);
    const sourceTexts = new Map(
      sources
        .map((source) => [source.id, fetched.sourceTexts.get(source.id)] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
    );
    return { section, sources, sourceTexts };
  });

  const synthesized = await mapWithConcurrency(
    sectionInputs,
    config.synthesisConcurrency,
    (input) => synthesizeSection(ctx, input.section, input.sources, input.sourceTexts),
  );

  const claims = synthesized.flatMap((section) => section.claims);
  ctx.project.claims.push(...claims);

  const anchorFit = await synthesizeFounderAnchorFit(ctx, anchors, synthesized);
  const viability = await summarizeViability(ctx, anchors, synthesized);

  const evaluated = await runEvaluatorLoop({
    audit: ctx.audit,
    project: ctx.project,
    stage: ctx.stageId,
    provider: ctx.provider,
    rubric: researchRubric,
    maxRounds: config.maxEvalRounds,
    generate: async () => renderReport(idea, viability, synthesized, anchorFit, ctx.project.sources),
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

import { z } from "zod";
import { config } from "../../config.js";
import type { AuditLogger } from "../../audit.js";
import { createProviderForStage } from "../../model/index.js";
import { CostCeilingExceededError } from "../../runtime/errors.js";
import { trackStageModelCall } from "../../runtime/telemetry.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { Claim, Project, Source, StageContext } from "../types.js";

/** Characters of source text to show on each side of a cited quote. */
const SKEPTIC_EXCERPT_RADIUS = 400;

/**
 * Build the source-text window around each cited quote so the skeptic can judge
 * the claim against its actual context — catching quotes used out of context,
 * not just claim-vs-quote mismatch.
 */
function citationExcerpts(claim: Claim, sourceTexts: Map<string, string>): string {
  return claim.citations
    .map((citation) => {
      const source = sourceTexts.get(citation.sourceId) ?? "";
      let excerpt = "";
      if (source) {
        const needle = citation.quote.trim().slice(0, 80).toLowerCase();
        const idx = needle ? source.toLowerCase().indexOf(needle) : -1;
        if (idx >= 0) {
          const start = Math.max(0, idx - SKEPTIC_EXCERPT_RADIUS);
          const end = Math.min(source.length, idx + citation.quote.length + SKEPTIC_EXCERPT_RADIUS);
          excerpt = source.slice(start, end);
        } else {
          excerpt = source.slice(0, SKEPTIC_EXCERPT_RADIUS * 2);
        }
      }
      return `Source [${citation.sourceId}] cited quote: "${citation.quote}"\nSurrounding source text:\n${
        excerpt || "(source text unavailable)"
      }`;
    })
    .join("\n\n");
}

export type CitationRejectionReason =
  | "unknown_source"
  | "quote_not_found"
  | "no_citation";

export function normalizeSourceText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const skepticSchema = z.object({
  refuted: z.boolean(),
  reason: z.string().optional(),
});

async function runSkepticCall(
  ctx: StageContext,
  claim: Claim,
  sourceTexts: Map<string, string>,
): Promise<{ refuted: boolean; reason?: string }> {
  if (config.provider === "mock") {
    return { refuted: false };
  }
  const skepticProvider = createProviderForStage(
    ctx.stageId,
    "flash",
    ctx.project.agentId,
    ctx.project.modelId,
  );

  const citationsInfo = claim.citations
    .map((citation) => {
      return `Source ID: [${citation.sourceId}]\nCited Quote: "${citation.quote}"`;
    })
    .join("\n\n");

  const systemPrompt = `You are a skeptic researcher. Your task is to critique a market claim and its supporting citations to find any contradiction, misrepresentation, or unsupported extrapolation.
Determine if the claim is refuted based on the cited quote and the surrounding source text provided.
If the claim goes beyond what is explicitly supported by the quote, takes the quote out of context, or contradicts the source, set refuted to true and provide the reason. If the claim is fully supported, set refuted to false.
Return only JSON.
Be specific and concise. No filler, no preamble, do not restate the prompt.`;

  try {
    const result = await skepticProvider.generate({
      purpose: "skeptic",
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Claim: "${claim.text}"\n\nCitations:\n${citationsInfo}\n\nEvidence excerpts:\n${citationExcerpts(
            claim,
            sourceTexts,
          )}`,
        },
      ],
      responseJsonSchema: z.toJSONSchema(skepticSchema),
      thinking: true,
      temperature: 0,
      maxOutputTokens: 1000,
    });

    trackStageModelCall(ctx.audit, ctx.project, ctx.stageId, "skeptic", result);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // A malformed skeptic response is a tooling failure, not evidence the
      // claim is false — keep the deterministic verification (fail-open).
      return { refuted: false, reason: "skeptic_unavailable: response was not valid JSON." };
    }

    const validated = skepticSchema.safeParse(parsed);
    if (!validated.success) {
      return { refuted: false, reason: "skeptic_unavailable: response failed schema validation." };
    }

    return validated.data;
  } catch (err) {
    // Budget exhaustion must abort the whole stage, not silently pass the claim.
    if (err instanceof CostCeilingExceededError) throw err;
    // Transient provider errors (429s, timeouts) are not refutations. Treating
    // them as refutations turned a single rate-limited call into a failed stage.
    // Fall open: keep the deterministic verification and record the gap.
    ctx.audit.record("error", {
      clientId: ctx.project.clientId,
      projectId: ctx.project.id,
      stage: ctx.stageId,
      error: `Skeptic call failed (claim kept on deterministic verification): ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return {
      refuted: false,
      reason: `skeptic_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function verifyClaims(
  ctx: StageContext,
  claims: Claim[],
  sourceTexts: Map<string, string>,
): Promise<Claim[]> {
  const project = ctx.project;
  const audit = ctx.audit;
  const sourceIds = new Set(project.sources.map((source) => source.id));

  // First Pass: Deterministic Verification
  const candidateClaims = claims.map((claim) => {
    const reason = claimRejectionReason(claim, sourceIds, sourceTexts);
    const verified = reason === null;
    const citations = claim.citations.map((citation) => ({
      sourceId: citation.sourceId,
      quote: citation.quote.trim(),
    }));
    const next: Claim = {
      ...claim,
      citations,
      sourceIds: citations.map((citation) => citation.sourceId),
      verified,
      support: verified ? "verified" : "unverified",
    };
    if (!verified) {
      audit.record("citation_rejected", {
        clientId: project.clientId,
        projectId: project.id,
        claim: claim.text,
        sourceIds: next.sourceIds,
        citations,
        reason: reason ?? "unverified",
      });
    }
    return next;
  });

  // Second Pass: Adversarial Verification (Skeptic). Bound concurrency — one
  // call per verified claim can easily be 30+, and an unbounded burst turns
  // provider rate limits into failures.
  const verifiedClaims = candidateClaims.filter((claim) => claim.verified);
  const skepticResults = await mapWithConcurrency(
    verifiedClaims,
    config.researchConcurrency,
    (claim) => runSkepticCall(ctx, claim, sourceTexts),
  );

  let skepticIdx = 0;
  return candidateClaims.map((claim) => {
    if (!claim.verified) return claim;

    const skepticResult = skepticResults[skepticIdx++];
    if (!skepticResult || skepticResult.refuted) {
      audit.record("citation_rejected", {
        clientId: project.clientId,
        projectId: project.id,
        claim: claim.text,
        sourceIds: claim.sourceIds,
        citations: claim.citations,
        reason: skepticResult?.reason ?? "refuted_by_skeptic",
      });
      return {
        ...claim,
        verified: false,
        support: "unverified",
      };
    } else {
      audit.record("citation_verified", {
        clientId: project.clientId,
        projectId: project.id,
        claim: claim.text,
        sourceIds: claim.sourceIds,
        citations: claim.citations,
        reason: "verified",
      });
      return claim;
    }
  });
}

export function claimRejectionReason(
  claim: Claim,
  sourceIds: Set<string>,
  sourceTexts: Map<string, string>,
): CitationRejectionReason | null {
  if (!claim.citations.length) return "no_citation";

  for (const citation of claim.citations) {
    if (!sourceIds.has(citation.sourceId)) return "unknown_source";
    const normalizedQuote = normalizeSourceText(citation.quote);
    const normalizedSource = normalizeSourceText(sourceTexts.get(citation.sourceId) ?? "");
    if (!normalizedQuote || !normalizedSource.includes(normalizedQuote)) {
      return "quote_not_found";
    }
  }

  return null;
}

export function sourceAppendix(sources: Source[]): string {
  if (!sources.length) return "No sources were registered.";
  return sources
    .map(
      (source) =>
        `- [${source.id}] ${source.title}. ${source.url} (score ${source.qualityScore}, retrieved ${source.retrievedAt}, sha256 ${source.contentHash})`,
    )
    .join("\n");
}

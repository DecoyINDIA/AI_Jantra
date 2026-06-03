import type { AuditLogger } from "../../audit.js";
import type { Claim, Project, Source } from "../types.js";

export type CitationRejectionReason =
  | "unknown_source"
  | "quote_not_found"
  | "no_citation";

export function normalizeSourceText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyClaims(
  project: Project,
  audit: AuditLogger,
  claims: Claim[],
  sourceTexts: Map<string, string>,
): Claim[] {
  const sourceIds = new Set(project.sources.map((source) => source.id));
  return claims.map((claim) => {
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
    audit.record(verified ? "citation_verified" : "citation_rejected", {
      clientId: project.clientId,
      projectId: project.id,
      claim: claim.text,
      sourceIds: next.sourceIds,
      citations,
      reason: reason ?? "verified",
    });
    return next;
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

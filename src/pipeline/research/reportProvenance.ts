import type { Claim } from "../types.js";

export interface ProvenanceResult {
  ok: boolean;
  orphanNumbers: string[];
  unknownSourceRefs: string[];
}

/**
 * Extracts and normalizes numbers from markdown text, stripping markdown link
 * targets and source-reference brackets first.
 */
function extractNumbers(text: string): string[] {
  // Strip markdown link targets [text](url) -> "text"
  const withoutLinkTargets = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Strip bracketed source references [id] that are not markdown links -> " "
  const withoutSourceRefs = withoutLinkTargets.replace(/\[[A-Za-z0-9_-]+\](?!\()/g, " ");

  const matches = withoutSourceRefs.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!matches) return [];

  const result: string[] = [];
  for (const m of matches) {
    const rawVal = m.replace(/,/g, "");
    const num = Number(rawVal);
    if (!Number.isNaN(num)) {
      result.push(String(num));
    }
  }
  return result;
}

/**
 * Verifies that a refined research report does not introduce unverified
 * figures or unknown source references absent from the verified baseline and claims.
 */
export function checkReportProvenance(args: {
  finalReport: string;
  baselineReport: string;
  verifiedClaims: Claim[];
  knownSourceIds: string[];
}): ProvenanceResult {
  const allowedNumbers = new Set<string>();

  for (const n of extractNumbers(args.baselineReport)) {
    allowedNumbers.add(n);
  }

  for (const claim of args.verifiedClaims) {
    for (const n of extractNumbers(claim.text)) {
      allowedNumbers.add(n);
    }
    if (claim.citations) {
      for (const citation of claim.citations) {
        if (citation.quote) {
          for (const n of extractNumbers(citation.quote)) {
            allowedNumbers.add(n);
          }
        }
      }
    }
  }

  const finalNumbers = extractNumbers(args.finalReport);
  const orphanNumbers: string[] = [];
  const seenOrphans = new Set<string>();

  for (const canonical of finalNumbers) {
    const num = Number(canonical);
    // Ignore small integers 0-12 (list numbers, ordinals, small counts)
    if (Number.isInteger(num) && num >= 0 && num <= 12) {
      continue;
    }

    if (!allowedNumbers.has(canonical)) {
      if (!seenOrphans.has(canonical)) {
        seenOrphans.add(canonical);
        orphanNumbers.push(canonical);
      }
    }
  }

  const unknownSourceRefs: string[] = [];
  const seenUnknownRefs = new Set<string>();
  const knownSourceSet = new Set(args.knownSourceIds);
  const sourceRefRegex = /\[([A-Za-z0-9_-]+)\](?!\()/g;
  let refMatch: RegExpExecArray | null;

  while ((refMatch = sourceRefRegex.exec(args.finalReport)) !== null) {
    const id = refMatch[1]!;
    if (!knownSourceSet.has(id) && !seenUnknownRefs.has(id)) {
      seenUnknownRefs.add(id);
      unknownSourceRefs.push(id);
    }
  }

  return {
    ok: orphanNumbers.length === 0 && unknownSourceRefs.length === 0,
    orphanNumbers,
    unknownSourceRefs,
  };
}

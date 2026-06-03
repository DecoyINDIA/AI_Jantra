import { normalizeUrl, scoreSourceCandidate } from "./sourceQuality.js";

export interface CitationCandidateInput {
  uri: string;
  title: string;
  sectionTitle: string;
}

export interface CitationCandidate {
  uri: string;
  normalizedUrl: string;
  title: string;
  sectionTitles: string[];
  score: number;
}

export function dedupeCitationCandidates(
  inputs: CitationCandidateInput[],
): CitationCandidate[] {
  const byUrl = new Map<string, CitationCandidate>();
  for (const input of inputs) {
    const normalizedUrl = normalizeUrl(input.uri);
    const score = scoreSourceCandidate(input.uri, input.title);
    const existing = byUrl.get(normalizedUrl);
    if (existing) {
      if (!existing.sectionTitles.includes(input.sectionTitle)) {
        existing.sectionTitles.push(input.sectionTitle);
      }
      if (score > existing.score) {
        existing.title = input.title;
        existing.score = score;
      }
      continue;
    }
    byUrl.set(normalizedUrl, {
      uri: input.uri,
      normalizedUrl,
      title: input.title,
      sectionTitles: [input.sectionTitle],
      score,
    });
  }
  return [...byUrl.values()];
}

export function rankAndCapCitationCandidates(
  candidates: CitationCandidate[],
  maxSources: number,
): { selected: CitationCandidate[]; dropped: CitationCandidate[] } {
  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || a.normalizedUrl.localeCompare(b.normalizedUrl),
  );
  return {
    selected: ranked.slice(0, maxSources),
    dropped: ranked.slice(maxSources),
  };
}

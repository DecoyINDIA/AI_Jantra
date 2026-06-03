import type { Source } from "../types.js";

const REPUTABLE_HOST_PATTERNS = [
  /\.gov$/,
  /\.edu$/,
  /(^|\.)sec\.gov$/,
  /(^|\.)bls\.gov$/,
  /(^|\.)sba\.gov$/,
  /(^|\.)who\.int$/,
  /(^|\.)nih\.gov$/,
  /(^|\.)oecd\.org$/,
  /(^|\.)worldbank\.org$/,
  /(^|\.)stripe\.com$/,
  /(^|\.)shopify\.com$/,
  /(^|\.)intuit\.com$/,
  /(^|\.)mckinsey\.com$/,
  /(^|\.)gartner\.com$/,
  /(^|\.)cbinsights\.com$/,
];

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

function pathDepth(url: URL): number {
  return url.pathname.split("/").filter(Boolean).length;
}

function hasDateSignal(text: string): boolean {
  return /\b(20\d{2}|19\d{2})\b/.test(text) || /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(text);
}

export function scoreSourceCandidate(url: string, title = ""): number {
  let score = 0;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.protocol === "https:") score += 2;
    if (REPUTABLE_HOST_PATTERNS.some((pattern) => pattern.test(host))) score += 4;
    if (/^(docs|developer|help|support|investor|research)\./.test(host)) score += 1;
    if (/(\/docs\/|\/developer|\/help|\/support|\/research|\/reports?\/)/i.test(parsed.pathname)) {
      score += 1;
    }
    if (hasDateSignal(`${parsed.pathname} ${title}`)) score += 1;
    const depth = pathDepth(parsed);
    score += depth <= 4 ? 2 : depth <= 6 ? 1 : 0;
  } catch {
    score += url.startsWith("https://") ? 1 : 0;
  }
  return score;
}

export function scoreSource(source: Source): number {
  return scoreSourceCandidate(source.url, source.title);
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { config } from "../../config.js";
import { sanitizeUntrustedWebContent } from "../../policy.js";

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  sanitized: string;
  contentHash: string;
  promptInjectionFlags: string[];
}

function extractTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return (match?.[1] ?? fallback).replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function fetchPage(url: string, titleHint?: string): Promise<FetchedPage> {
  if (url.startsWith("file://")) {
    if (config.provider !== "mock") {
      throw new Error("Refusing to read file URLs outside the mock provider.");
    }
    const raw = await readFile(fileURLToPath(url), "utf8");
    const title = extractTitle(raw, titleHint ?? url);
    const text = htmlToText(raw).slice(0, 40_000);
    const { sanitized, verdict } = sanitizeUntrustedWebContent(text);
    return {
      url,
      title,
      content: text,
      sanitized,
      contentHash: hashContent(text),
      promptInjectionFlags: verdict.flags,
    };
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported fetch URL scheme: ${parsedUrl.protocol}`);
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": "JantraAIResearchBot/0.1 (+https://xolver.ai)",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${response.status}`);
  }
  const raw = await response.text();
  const title = extractTitle(raw, titleHint ?? url);
  const text = htmlToText(raw).slice(0, 40_000);
  const { sanitized, verdict } = sanitizeUntrustedWebContent(text);
  return {
    url,
    title,
    content: text,
    sanitized,
    contentHash: hashContent(text),
    promptInjectionFlags: verdict.flags,
  };
}

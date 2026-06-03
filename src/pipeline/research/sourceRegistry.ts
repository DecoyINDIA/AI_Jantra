import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditLogger } from "../../audit.js";
import { writeSourceContentFile } from "../store.js";
import type { Project, Source } from "../types.js";
import type { FetchedPage } from "./webFetch.js";
import { normalizeUrl, scoreSource } from "./sourceQuality.js";

function sourceIdForPage(page: FetchedPage): string {
  if (page.url.startsWith("file://")) {
    const file = basename(fileURLToPath(page.url), extname(fileURLToPath(page.url)));
    return `src_${file.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }
  return `src_${randomUUID().slice(0, 8)}`;
}

export function registerSource(
  project: Project,
  audit: AuditLogger,
  page: FetchedPage,
): Source {
  const normalizedPageUrl = normalizeUrl(page.url);
  const existing = project.sources.find((source) => normalizeUrl(source.url) === normalizedPageUrl);
  if (existing) return existing;

  const source: Source = {
    id: sourceIdForPage(page),
    clientId: project.clientId,
    url: page.url,
    title: page.title,
    retrievedAt: new Date().toISOString(),
    contentHash: page.contentHash,
    qualityScore: 0,
  };
  source.qualityScore = scoreSource(source);
  source.contentPath = writeSourceContentFile(project.clientId, project.id, source, page.content);
  project.sources.push(source);
  audit.record("source_registered", {
    clientId: project.clientId,
    projectId: project.id,
    source,
    promptInjectionFlags: page.promptInjectionFlags,
  });
  return source;
}

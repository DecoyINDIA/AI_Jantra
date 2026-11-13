import type { Project, Artifact, Claim, Source } from "../../pipeline/types.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^(https?:|\/|#)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function renderInline(text: string): string {
  // First escape raw HTML in text
  let res = escapeHtml(text);
  // Code spans `code`
  res = res.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Bold **text**
  res = res.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`);
  // Italic *text*
  res = res.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, (_m, p1, it, p2) => `${p1}<em>${it}</em>${p2}`);
  // Markdown links [label](url)
  res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const safe = safeUrl(url);
    if (safe) {
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return `${label} (${url})`;
  });
  // Bracketed source IDs [src-...]
  res = res.replace(/\[(src-[a-zA-Z0-9_-]+)\]/g, (_m, id) => `<span class="source-tag">[${id}]</span>`);
  return res;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const htmlParts: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  let inList: "ul" | "ol" | null = null;
  let inTable = false;
  let tableRows: string[][] = [];

  function flushList() {
    if (inList) {
      htmlParts.push(`</${inList}>`);
      inList = null;
    }
  }

  function flushTable() {
    if (inTable && tableRows.length > 0) {
      let tHtml = '<div class="table-container"><table>';
      const headerRow = tableRows[0];
      if (headerRow) {
        tHtml += "<thead><tr>";
        for (const cell of headerRow) {
          tHtml += `<th>${renderInline(cell)}</th>`;
        }
        tHtml += "</tr></thead>";
      }
      if (tableRows.length > 1) {
        tHtml += "<tbody>";
        for (let i = 1; i < tableRows.length; i++) {
          tHtml += "<tr>";
          for (const cell of tableRows[i] ?? []) {
            tHtml += `<td>${renderInline(cell)}</td>`;
          }
          tHtml += "</tr>";
        }
        tHtml += "</tbody>";
      }
      tHtml += "</table></div>";
      htmlParts.push(tHtml);
      tableRows = [];
      inTable = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code blocks
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        flushList();
        flushTable();
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim();
        codeBlockLines = [];
      } else {
        inCodeBlock = false;
        const codeContent = escapeHtml(codeBlockLines.join("\n"));
        htmlParts.push(
          `<pre><code class="lang-${escapeHtml(codeBlockLang)}">${codeContent}</code></pre>`,
        );
        codeBlockLang = "";
        codeBlockLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Table rows
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushList();
      // Check if separator row e.g. |---|---|
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      inTable = true;
      tableRows.push(cells);
      continue;
    } else {
      flushTable();
    }

    // Blank line
    if (!trimmed) {
      flushList();
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      flushList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const id = slugify(text);
      htmlParts.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      flushList();
      const quoteText = trimmed.replace(/^>\s*/, "");
      htmlParts.push(`<blockquote><p>${renderInline(quoteText)}</p></blockquote>`);
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch && ulMatch[2]) {
      if (inList !== "ul") {
        flushList();
        inList = "ul";
        htmlParts.push("<ul>");
      }
      htmlParts.push(`<li>${renderInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch && olMatch[2]) {
      if (inList !== "ol") {
        flushList();
        inList = "ol";
        htmlParts.push("<ol>");
      }
      htmlParts.push(`<li>${renderInline(olMatch[2])}</li>`);
      continue;
    }

    // Normal paragraph
    flushList();
    htmlParts.push(`<p>${renderInline(trimmed)}</p>`);
  }

  flushList();
  flushTable();

  return htmlParts.join("\n");
}

function renderClaimItem(claim: Claim, sourceMap: Map<string, Source>): string {
  const isVerified = claim.verified || claim.support === "verified";
  const badgeClass = isVerified ? "badge-verified" : "badge-unverified";
  const badgeText = isVerified ? "Verified Claim" : "Unverified Claim";
  const citations = claim.citations ?? [];

  let citationsHtml = "";
  if (citations.length > 0) {
    citationsHtml = `
      <details class="claim-citations" open>
        <summary class="citation-toggle">
          <span>Supporting Citations (${citations.length})</span>
        </summary>
        <div class="citation-list">
          ${citations
            .map((c) => {
              const src = sourceMap.get(c.sourceId);
              const srcTitle = src?.title ? escapeHtml(src.title) : "Registered Source";
              const safeSrcUrl = src?.url ? safeUrl(src.url) : null;
              const linkHtml = safeSrcUrl
                ? `<a href="${escapeHtml(safeSrcUrl)}" target="_blank" rel="noopener noreferrer" class="citation-url">${escapeHtml(safeSrcUrl)}</a>`
                : "";

              return `
                <div class="citation-entry">
                  <div class="citation-meta">
                    <span class="source-tag">[${escapeHtml(c.sourceId)}]</span>
                    <strong class="citation-source-title">${srcTitle}</strong>
                    ${linkHtml}
                  </div>
                  ${
                    c.quote
                      ? `<blockquote class="citation-quote">“${escapeHtml(c.quote)}”</blockquote>`
                      : ""
                  }
                </div>
              `;
            })
            .join("\n")}
        </div>
      </details>
    `;
  } else {
    citationsHtml = `
      <p class="citation-empty-note"><em>No citation quotes registered for this claim.</em></p>
    `;
  }

  return `
    <div class="claim-card ${isVerified ? "claim-card-verified" : "claim-card-unverified"}">
      <div class="claim-header">
        <span class="claim-badge ${badgeClass}">${badgeText}</span>
        <p class="claim-text">${renderInline(claim.text)}</p>
      </div>
      ${citationsHtml}
    </div>
  `;
}

function renderSourceRow(source: Source): string {
  const safeSrcUrl = safeUrl(source.url);
  const linkHtml = safeSrcUrl
    ? `<a href="${escapeHtml(safeSrcUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>`
    : escapeHtml(source.url);

  const qualityPercent = Math.round((source.qualityScore ?? 1.0) * 100);
  const shortHash = source.contentHash ? escapeHtml(source.contentHash.slice(0, 12)) : "-";

  return `
    <tr>
      <td><span class="source-tag">[${escapeHtml(source.id)}]</span></td>
      <td><strong>${escapeHtml(source.title || "Untitled")}</strong></td>
      <td class="url-cell">${linkHtml}</td>
      <td>${qualityPercent}%</td>
      <td>${escapeHtml(source.retrievedAt || "-")}</td>
      <td><code>${shortHash}</code></td>
    </tr>
  `;
}

export function renderClientReadyReport(project: Project): string {
  const sourceMap = new Map<string, Source>();
  for (const src of project.sources ?? []) {
    sourceMap.set(src.id, src);
  }

  const allArtifacts: Artifact[] = Object.values(project.stages ?? {})
    .flatMap((stage) => stage.artifacts ?? [])
    .filter((a) => Boolean(a && a.content));

  // Sort/prioritize canonical planning-pipeline artifact order:
  // idea_summary -> research_report -> prd -> trd -> build_plan -> other
  const kindPriority: Record<string, number> = {
    idea_summary: 1,
    research_report: 2,
    prd: 3,
    trd: 4,
    build_plan: 5,
  };

  allArtifacts.sort((a, b) => {
    const prioA = kindPriority[a.kind] ?? 99;
    const prioB = kindPriority[b.kind] ?? 99;
    if (prioA !== prioB) return prioA - prioB;
    return a.version - b.version;
  });

  const now = new Date().toISOString();
  const dateFormatted = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const renderedArtifactsHtml = allArtifacts
    .map((artifact) => {
      const artifactHtml = markdownToHtml(artifact.content);
      const evalBadge = artifact.eval
        ? `<span class="eval-badge ${artifact.eval.passed ? "eval-passed" : "eval-failed"}">
            ${artifact.eval.passed ? "Passed Stage Gate" : "Review Required"}
           </span>`
        : "";

      return `
        <article class="artifact-card" id="artifact-${escapeHtml(artifact.kind)}">
          <header class="artifact-header">
            <div>
              <span class="artifact-kind">${escapeHtml(artifact.kind.replace(/_/g, " ").toUpperCase())} (v${artifact.version})</span>
              <h2 class="artifact-title">${escapeHtml(artifact.title)}</h2>
            </div>
            ${evalBadge}
          </header>
          <div class="artifact-body">
            ${artifactHtml}
          </div>
        </article>
      `;
    })
    .join("\n\n");

  const claims = project.claims ?? [];
  let claimsSectionHtml = "";
  if (claims.length > 0) {
    const renderedClaims = claims.map((c) => renderClaimItem(c, sourceMap)).join("\n");
    claimsSectionHtml = `
      <section class="report-section" id="section-claims">
        <div class="section-title-wrap">
          <span class="section-eyebrow">Evidence Ledger</span>
          <h2>Verified Claims & Deterministic Citations</h2>
          <p class="section-desc">
            All factual claims evaluated against retrieved and content-hashed primary sources.
            Expand each claim to inspect the exact quote and source URL.
          </p>
        </div>
        <div class="claims-list">
          ${renderedClaims}
        </div>
      </section>
    `;
  }

  const sources = project.sources ?? [];
  let sourcesSectionHtml = "";
  if (sources.length > 0) {
    sourcesSectionHtml = `
      <section class="report-section" id="section-sources">
        <div class="section-title-wrap">
          <span class="section-eyebrow">Audit Appendix</span>
          <h2>Verified Source Registry</h2>
          <p class="section-desc">
            Sources retrieved, content-hashed, and deterministically verified during the research stage.
          </p>
        </div>
        <div class="table-container">
          <table class="sources-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Source Title</th>
                <th>URL</th>
                <th>Quality</th>
                <th>Retrieved At</th>
                <th>Content Hash</th>
              </tr>
            </thead>
            <tbody>
              ${sources.map(renderSourceRow).join("\n")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.title)} — Client-Ready Deliverable | Jantra</title>
  <style>
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --color-bg: #f8fafc;
      --color-surface: #ffffff;
      --color-border: #e2e8f0;
      --color-border-subtle: #f1f5f9;
      --color-text: #0f172a;
      --color-text-muted: #475569;
      --color-primary: #0284c7;
      --color-primary-hover: #0369a1;
      --color-verified-bg: #f0fdf4;
      --color-verified-border: #86efac;
      --color-verified-text: #166534;
      --color-unverified-bg: #fffbeb;
      --color-unverified-border: #fcd34d;
      --color-unverified-text: #92400e;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      color: var(--color-text);
      background-color: var(--color-bg);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 64px;
    }

    /* Action bar */
    .action-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      background-color: #0f172a;
      color: #f8fafc;
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .action-bar-brand {
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .action-bar-meta {
      font-size: 13px;
      color: #94a3b8;
    }
    .btn-print {
      background-color: #0284c7;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color 0.15s ease;
    }
    .btn-print:hover {
      background-color: #0369a1;
    }

    /* Document container */
    .container {
      max-width: 900px;
      margin: 32px auto;
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      padding: 48px;
    }

    /* Cover / Header */
    .report-cover {
      border-bottom: 2px solid var(--color-border);
      padding-bottom: 32px;
      margin-bottom: 40px;
    }
    .cover-eyebrow {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-primary);
      margin-bottom: 8px;
      display: block;
    }
    .report-title {
      font-size: 32px;
      font-weight: 800;
      line-height: 1.25;
      color: var(--color-text);
      letter-spacing: -0.02em;
      margin-bottom: 20px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      background-color: var(--color-border-subtle);
      border: 1px solid var(--color-border);
      border-radius: 6px;
      padding: 16px;
      font-size: 13px;
    }
    .meta-item {
      display: flex;
      flex-direction: column;
    }
    .meta-label {
      color: var(--color-text-muted);
      font-weight: 500;
      margin-bottom: 2px;
    }
    .meta-value {
      font-weight: 600;
      color: var(--color-text);
    }

    /* Artifact cards */
    .artifact-card {
      margin-bottom: 48px;
      padding-bottom: 40px;
      border-bottom: 1px solid var(--color-border);
    }
    .artifact-card:last-of-type {
      border-bottom: none;
    }
    .artifact-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--color-border-subtle);
    }
    .artifact-kind {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--color-primary);
      display: block;
      margin-bottom: 4px;
    }
    .artifact-title {
      font-size: 24px;
      font-weight: 700;
      color: var(--color-text);
      letter-spacing: -0.01em;
    }
    .eval-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .eval-passed {
      background-color: var(--color-verified-bg);
      color: var(--color-verified-text);
      border: 1px solid var(--color-verified-border);
    }
    .eval-failed {
      background-color: var(--color-unverified-bg);
      color: var(--color-unverified-text);
      border: 1px solid var(--color-unverified-border);
    }

    /* Markdown typography */
    .artifact-body {
      font-size: 15px;
      line-height: 1.7;
      color: #1e293b;
    }
    .artifact-body h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 28px 0 14px 0;
      letter-spacing: -0.01em;
    }
    .artifact-body h2 {
      font-size: 18px;
      font-weight: 700;
      margin: 24px 0 12px 0;
      border-bottom: 1px solid var(--color-border-subtle);
      padding-bottom: 6px;
    }
    .artifact-body h3 {
      font-size: 16px;
      font-weight: 700;
      margin: 20px 0 10px 0;
    }
    .artifact-body p {
      margin-bottom: 14px;
    }
    .artifact-body ul, .artifact-body ol {
      margin: 0 0 16px 24px;
    }
    .artifact-body li {
      margin-bottom: 6px;
    }
    .artifact-body blockquote {
      border-left: 3px solid var(--color-primary);
      background-color: var(--color-border-subtle);
      padding: 10px 16px;
      margin: 16px 0;
      border-radius: 0 4px 4px 0;
      font-style: italic;
    }
    .artifact-body code {
      font-family: var(--font-mono);
      font-size: 13px;
      background-color: var(--color-border-subtle);
      padding: 2px 5px;
      border-radius: 3px;
      border: 1px solid var(--color-border);
    }
    .artifact-body pre {
      background-color: #0f172a;
      color: #f8fafc;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 16px 0;
    }
    .artifact-body pre code {
      background-color: transparent;
      color: inherit;
      border: none;
      padding: 0;
      font-size: 13px;
    }
    .artifact-body a {
      color: var(--color-primary);
      text-decoration: underline;
    }

    /* Tables */
    .table-container {
      overflow-x: auto;
      margin: 20px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th, td {
      padding: 10px 14px;
      border: 1px solid var(--color-border);
    }
    th {
      background-color: var(--color-border-subtle);
      font-weight: 600;
      color: var(--color-text);
    }
    tr:nth-child(even) td {
      background-color: #fafbfd;
    }

    /* Sections */
    .report-section {
      margin-top: 48px;
      padding-top: 36px;
      border-top: 2px solid var(--color-border);
    }
    .section-title-wrap {
      margin-bottom: 24px;
    }
    .section-eyebrow {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-primary);
      display: block;
      margin-bottom: 4px;
    }
    .section-title-wrap h2 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.01em;
      margin-bottom: 6px;
    }
    .section-desc {
      font-size: 14px;
      color: var(--color-text-muted);
    }

    /* Claim cards */
    .claims-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .claim-card {
      border: 1px solid var(--color-border);
      border-radius: 6px;
      padding: 16px;
      background-color: var(--color-surface);
    }
    .claim-card-verified {
      border-left: 4px solid var(--color-verified-border);
    }
    .claim-card-unverified {
      border-left: 4px solid var(--color-unverified-border);
    }
    .claim-header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }
    .claim-badge {
      display: inline-block;
      align-self: flex-start;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-verified {
      background-color: var(--color-verified-bg);
      color: var(--color-verified-text);
      border: 1px solid var(--color-verified-border);
    }
    .badge-unverified {
      background-color: var(--color-unverified-bg);
      color: var(--color-unverified-text);
      border: 1px solid var(--color-unverified-border);
    }
    .claim-text {
      font-size: 15px;
      font-weight: 600;
      color: var(--color-text);
    }
    .claim-citations {
      margin-top: 10px;
      border-top: 1px dashed var(--color-border);
      padding-top: 10px;
    }
    .citation-toggle {
      font-size: 13px;
      font-weight: 600;
      color: var(--color-primary);
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
    }
    .citation-list {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .citation-entry {
      background-color: var(--color-border-subtle);
      border: 1px solid var(--color-border);
      border-radius: 4px;
      padding: 10px 14px;
      font-size: 13px;
    }
    .citation-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .source-tag {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      color: var(--color-primary);
    }
    .citation-source-title {
      color: var(--color-text);
    }
    .citation-url {
      color: var(--color-primary);
      text-decoration: underline;
      font-size: 12px;
      word-break: break-all;
    }
    .citation-quote {
      font-style: italic;
      color: var(--color-text);
      background-color: #ffffff;
      border-left: 3px solid var(--color-primary);
      padding: 8px 12px;
      border-radius: 0 4px 4px 0;
      margin-top: 6px;
    }
    .citation-empty-note {
      font-size: 13px;
      color: var(--color-text-muted);
      margin-top: 6px;
    }

    /* Sources table */
    .sources-table th, .sources-table td {
      font-size: 12px;
    }
    .url-cell {
      max-width: 280px;
      word-break: break-all;
    }

    /* Footer */
    .report-footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid var(--color-border);
      font-size: 12px;
      color: var(--color-text-muted);
      text-align: center;
    }

    /* Print Styles */
    @media print {
      .no-print {
        display: none !important;
      }
      body {
        background-color: #ffffff !important;
        color: #000000 !important;
        font-size: 11pt !important;
        line-height: 1.5 !important;
        padding-bottom: 0 !important;
      }
      .container {
        max-width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        box-shadow: none !important;
      }
      @page {
        margin: 15mm 20mm;
        size: A4 portrait;
      }
      details.claim-citations {
        display: block !important;
      }
      details.claim-citations > summary {
        display: none !important;
      }
      details.claim-citations > .citation-list {
        display: flex !important;
      }
      .artifact-card, .claim-card, .table-container, table, pre, blockquote {
        page-break-inside: avoid;
      }
      h1, h2, h3, h4 {
        page-break-after: avoid;
      }
      a {
        color: #000000 !important;
        text-decoration: underline !important;
      }
    }
  </style>
</head>
<body>
  <div class="action-bar no-print">
    <div class="action-bar-brand">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>
      Jantra Client-Ready Deliverable
    </div>
    <div class="action-bar-meta">
      Run ${escapeHtml(project.id)} • ${escapeHtml(dateFormatted)}
    </div>
    <button type="button" class="btn-print" onclick="window.print()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 6 2 18 2 18 9"></polyline>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
        <rect x="6" y="14" width="12" height="8"></rect>
      </svg>
      Print / Save as PDF
    </button>
  </div>

  <main class="container">
    <header class="report-cover">
      <span class="cover-eyebrow">Autonomous Planning & Research Deliverable</span>
      <h1 class="report-title">${escapeHtml(project.title)}</h1>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">Client / Tenant</span>
          <span class="meta-value">${escapeHtml(project.clientId)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Agent Engine</span>
          <span class="meta-value">${escapeHtml(project.agentDefinitionSnapshot?.name ?? project.agentId)} (v${project.agentVersion})</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Run ID</span>
          <span class="meta-value"><code>${escapeHtml(project.id)}</code></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Execution Status</span>
          <span class="meta-value">${escapeHtml(project.status.toUpperCase())} (${escapeHtml(project.autonomy ?? "gated")})</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Total Spend</span>
          <span class="meta-value">$${(project.cost?.usd ?? 0).toFixed(4)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Generated</span>
          <span class="meta-value">${escapeHtml(dateFormatted)}</span>
        </div>
      </div>
    </header>

    ${renderedArtifactsHtml}

    ${claimsSectionHtml}

    ${sourcesSectionHtml}

    <footer class="report-footer">
      <p>Generated by Jantra AI Autonomous Agent Runtime • Verified against retrieved primary sources • ${escapeHtml(now)}</p>
    </footer>
  </main>
</body>
</html>
`;
}

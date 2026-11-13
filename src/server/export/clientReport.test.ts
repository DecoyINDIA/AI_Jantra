import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProject } from "../../pipeline/orchestrator.js";
import type { Project, Artifact, Claim, Source } from "../../pipeline/types.js";
import { markdownToHtml, renderClientReadyReport } from "./clientReport.js";

describe("markdownToHtml", () => {
  it("escapes raw HTML script tags to prevent XSS", () => {
    const raw = "Here is some code: <script>alert('xss')</script>";
    const html = markdownToHtml(raw);
    assert(!html.includes("<script>"), "Raw script tag must not appear");
    assert(html.includes("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"));
  });

  it("renders headings, bold, italic, and code spans", () => {
    const md = "## Section Title\n\nThis is **bold** and *italic* with `inline code`.";
    const html = markdownToHtml(md);
    assert(html.includes('<h2 id="section-title">Section Title</h2>'));
    assert(html.includes("<strong>bold</strong>"));
    assert(html.includes("<em>italic</em>"));
    assert(html.includes("<code>inline code</code>"));
  });

  it("renders markdown tables properly", () => {
    const md = `
| Feature | Supported | Cost |
|---|---|---|
| Search | Yes | $0.01 |
| Export | Yes | Free |
`;
    const html = markdownToHtml(md);
    assert(html.includes("<table"), "Must produce a table element");
    assert(html.includes("<th>Feature</th>"));
    assert(html.includes("<td>Search</td>"));
    assert(html.includes("<td>Free</td>"));
  });

  it("sanitizes javascript: links", () => {
    const md = "[Click me](javascript:alert(1)) and [Good Link](https://xolver.in)";
    const html = markdownToHtml(md);
    assert(!html.includes('href="javascript:'), "Must not allow javascript: in href");
    assert(html.includes('href="https://xolver.in"'));
  });

  it("renders fenced code blocks", () => {
    const md = "```ts\nconst x = 42;\n```";
    const html = markdownToHtml(md);
    assert(html.includes('<pre><code class="lang-ts">const x = 42;</code></pre>'));
  });
});

describe("renderClientReadyReport", () => {
  const sampleSource: Source = {
    id: "src-techcrunch",
    clientId: "test-client",
    title: "TechCrunch AI Market Report",
    url: "https://techcrunch.com/2026/market-report",
    retrievedAt: "2026-03-14T10:00:00Z",
    contentHash: "abcdef1234567890",
    qualityScore: 0.95,
  };

  const sampleClaim: Claim = {
    text: "The B2B SaaS agent market expanded 40% year-over-year in 2025.",
    verified: true,
    support: "verified",
    sourceIds: ["src-techcrunch"],
    citations: [
      {
        sourceId: "src-techcrunch",
        quote: "Enterprise spending on agentic orchestration platforms grew by 40% throughout 2025.",
      },
    ],
  };

  const sampleArtifacts: Artifact[] = [
    {
      stage: "intake",
      kind: "idea_summary",
      title: "Idea Summary",
      content: "# Executive Concept\n\nIntelligent agentic pipeline for enterprise workflows.",
      version: 1,
      createdAt: "2026-03-14T09:00:00Z",
    },
    {
      stage: "research",
      kind: "research_report",
      title: "Market Research Report",
      content: "## Market Findings\n\nHigh demand across mid-market B2B.",
      version: 1,
      createdAt: "2026-03-14T09:30:00Z",
    },
    {
      stage: "planning",
      kind: "prd",
      title: "Product Requirements Document",
      content: "## Core Features\n\n1. Autonomous ingestion\n2. Deterministic verification",
      version: 1,
      createdAt: "2026-03-14T10:00:00Z",
    },
    {
      stage: "planning",
      kind: "trd",
      title: "Technical Requirements Document",
      content: "## Architecture\n\nFastify + SQLite runtime.",
      version: 1,
      createdAt: "2026-03-14T10:15:00Z",
    },
    {
      stage: "planning",
      kind: "build_plan",
      title: "Phased Build Plan",
      content: "## Phase 1: MVP\n\nImplement core API and data persistence.",
      version: 1,
      createdAt: "2026-03-14T10:30:00Z",
    },
  ];

  const sampleProject: Project = createProject({
    clientId: "client-acme",
    title: "Enterprise Agent Platform",
    agentId: "planning-pipeline",
  });
  sampleProject.id = "run-export-test";
  sampleProject.status = "active";
  sampleProject.currentStage = "planning";
  sampleProject.stages = {
    intake: {
      id: "intake",
      status: "confirmed",
      artifacts: [sampleArtifacts[0]!],
      evals: [],
      updatedAt: "2026-03-14T09:00:00Z",
    },
    research: {
      id: "research",
      status: "confirmed",
      artifacts: [sampleArtifacts[1]!],
      evals: [],
      updatedAt: "2026-03-14T09:30:00Z",
    },
    planning: {
      id: "planning",
      status: "in_progress",
      artifacts: [sampleArtifacts[2]!, sampleArtifacts[3]!, sampleArtifacts[4]!],
      evals: [],
      updatedAt: "2026-03-14T10:30:00Z",
    },
  };
  sampleProject.sources = [sampleSource];
  sampleProject.claims = [sampleClaim];
  sampleProject.cost = {
    usd: 0.1245,
    inputTokens: 5000,
    outputTokens: 1200,
    cachedTokens: 800,
    thinkingTokens: 400,
    groundedPrompts: 2,
    perStage: {},
  };

  it("renders a full client-ready report with artifacts, claims, citations, and sources", () => {
    const html = renderClientReadyReport(sampleProject);

    // Document & Meta
    assert(html.includes("<!DOCTYPE html>"));
    assert(html.includes("Enterprise Agent Platform"));
    assert(html.includes("client-acme"));
    assert(html.includes("run-export-test"));
    assert(html.includes("Jantra Planning Pipeline"));

    // Print & PDF styling
    assert(html.includes("@media print"), "Must include print styles");
    assert(html.includes("@page"), "Must include @page CSS");
    assert(html.includes("window.print()"), "Must include print button trigger");
    assert(html.includes("no-print"), "Must include no-print class for screen controls");

    // All 5 planning pipeline artifacts
    assert(html.includes("Idea Summary"));
    assert(html.includes("Market Research Report"));
    assert(html.includes("Product Requirements Document"));
    assert(html.includes("Technical Requirements Document"));
    assert(html.includes("Phased Build Plan"));

    // Claims & Quotes
    assert(html.includes("The B2B SaaS agent market expanded 40% year-over-year in 2025."));
    assert(html.includes("Verified Claim"));
    assert(html.includes("TechCrunch AI Market Report"));
    assert(html.includes("https://techcrunch.com/2026/market-report"));
    assert(html.includes("Enterprise spending on agentic orchestration platforms grew by 40% throughout 2025."));

    // Sources Appendix
    assert(html.includes("Verified Source Registry"));
    assert(html.includes("[src-techcrunch]"));
    assert(html.includes("95%")); // quality score
  });
});

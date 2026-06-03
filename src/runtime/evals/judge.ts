import type { EvalFixture } from "./fixtures.js";
import type { StageEvalResult } from "./report.js";
import { AuditLogger } from "../../audit.js";
import { planningPipelineDefinition } from "../../agents/planningPipeline.js";
import { snapshotDefinition } from "../../agents/definition.js";
import { checkCrossDocumentConsistency } from "../../pipeline/planning/consistency.js";
import type { PlanningDocument } from "../../pipeline/planning/schemas.js";
import { claimRejectionReason } from "../../pipeline/research/citationVerifier.js";
import {
  dedupeCitationCandidates,
  rankAndCapCitationCandidates,
} from "../../pipeline/research/sourceSelection.js";
import { scoreSource } from "../../pipeline/research/sourceQuality.js";
import type { Claim, Project, Source, StageId, StageState } from "../../pipeline/types.js";
import { makeEvalScore, runEvaluatorLoop, type Rubric } from "../evaluator.js";
import { StageFailedClosedError } from "../errors.js";
import { emptyCostRollup } from "../telemetry.js";

function containsAll(text: string, values: string[]): boolean {
  const lower = text.toLowerCase();
  return values.every((value) => containsConcept(lower, value));
}

function containsAny(text: string, values: string[]): boolean {
  const lower = text.toLowerCase();
  return values.some((value) => containsConcept(lower, value));
}

function containsConcept(lowerText: string, value: string): boolean {
  const lowerValue = value.toLowerCase();
  if (lowerText.includes(lowerValue)) {
    return true;
  }
  const tokens = lowerValue.match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => token.length >= 5 && lowerText.includes(token.slice(0, 7)));
}

function evalStage(id: StageId): StageState {
  return {
    id,
    status: id === "build" ? "skipped" : "pending",
    artifacts: [],
    evals: [],
    updatedAt: new Date().toISOString(),
  };
}

function makeEvalProject(id: string): Project {
  const now = new Date().toISOString();
  const snapshot = snapshotDefinition(planningPipelineDefinition);
  return {
    id,
    title: "Eval project",
    clientId: "eval",
    agentId: snapshot.id,
    agentVersion: snapshot.version,
    agentDefinitionSnapshot: snapshot,
    status: "active",
    currentStage: "research",
    stages: {
      intake: evalStage("intake"),
      research: evalStage("research"),
      planning: evalStage("planning"),
      build: evalStage("build"),
    },
    sources: [],
    claims: [],
    interactions: [],
    execution: {},
    cost: emptyCostRollup(snapshot.stageOrder),
    createdAt: now,
    updatedAt: now,
  };
}

export function judgeIntakeFixture(fixture: EvalFixture): StageEvalResult {
  const expected = [
    ...fixture.expected.users,
    ...fixture.expected.features,
    ...fixture.expected.risks,
  ];
  const hasUserAnchor = containsAny(fixture.idea, fixture.expected.users);
  const hasFeatureAnchor = containsAny(fixture.idea, fixture.expected.features);
  const score = hasUserAnchor && hasFeatureAnchor
    ? containsAll(fixture.idea, fixture.expected.users)
      ? 5
      : 4
    : 2;
  return {
    fixtureId: fixture.id,
    stage: "intake",
    score,
    passed: score >= 4,
    notes: `Fixture has intake anchors for ${expected.length} expected evaluation terms.`,
  };
}

export function judgeResearchVerification(fixture: EvalFixture): StageEvalResult {
  const sourceIds = new Set(["src_eval"]);
  const sourceTexts = new Map([
    [
      "src_eval",
      "Finance teams reconcile Shopify orders, Stripe payments, and QuickBooks invoices each morning.",
    ],
  ]);
  const claims: Claim[] = [
    {
      text: "A verified claim.",
      citations: [
        {
          sourceId: "src_eval",
          quote: "reconcile Shopify orders, Stripe payments, and QuickBooks invoices",
        },
      ],
      sourceIds: ["src_eval"],
      verified: false,
      support: "unverified",
    },
    {
      text: "A claim with an absent quote.",
      citations: [{ sourceId: "src_eval", quote: "this phrase is not present" }],
      sourceIds: ["src_eval"],
      verified: false,
      support: "unverified",
    },
    {
      text: "A claim without citations.",
      citations: [],
      sourceIds: [],
      verified: false,
      support: "unverified",
    },
  ];
  const good = claims[0]
    ? claimRejectionReason(claims[0], sourceIds, sourceTexts) === null
    : false;
  const absentQuote = claims[1]
    ? claimRejectionReason(claims[1], sourceIds, sourceTexts) === "quote_not_found"
    : false;
  const emptyCitation = claims[2]
    ? claimRejectionReason(claims[2], sourceIds, sourceTexts) === "no_citation"
    : false;
  const passed = good && absentQuote && emptyCitation;
  return {
    fixtureId: fixture.id,
    stage: "research",
    score: passed ? 5 : 1,
    passed,
    notes: "Deterministic citation verifier requires registered source IDs and verbatim source quotes.",
  };
}

export function judgeResearchSourceSelection(): StageEvalResult {
  const deduped = dedupeCitationCandidates([
    {
      uri: "https://www.stripe.com/docs/payments?utm_source=test#overview",
      title: "Stripe payments documentation",
      sectionTitle: "Payments",
    },
    {
      uri: "https://stripe.com/docs/payments/",
      title: "Stripe docs duplicate",
      sectionTitle: "Pricing",
    },
    {
      uri: "http://anonymous-blog.example.com/deep/path/with/no/source",
      title: "Anonymous blog",
      sectionTitle: "Payments",
    },
  ]);
  const official: Source = {
    id: "official",
    clientId: "eval",
    url: "https://stripe.com/docs/payments/2026",
    title: "Stripe payments documentation 2026",
    retrievedAt: new Date().toISOString(),
    contentHash: "hash",
    qualityScore: 0,
  };
  const blog: Source = {
    id: "blog",
    clientId: "eval",
    url: "http://anonymous-blog.example.com/deep/path/with/no/source",
    title: "Anonymous blog",
    retrievedAt: new Date().toISOString(),
    contentHash: "hash",
    qualityScore: 0,
  };
  const capped = rankAndCapCitationCandidates(deduped, 1);
  const passed =
    deduped.length === 2 &&
    deduped.some((candidate) => candidate.sectionTitles.length === 2) &&
    scoreSource(official) > scoreSource(blog) &&
    capped.selected.length === 1 &&
    capped.dropped.length === 1 &&
    capped.selected[0]?.uri.includes("stripe.com") === true;
  return {
    fixtureId: "research-source-selection",
    stage: "research",
    score: passed ? 5 : 1,
    passed,
    notes: passed
      ? "Source selection dedupes normalized URLs, ranks official sources higher, and reports capped drops."
      : "Source selection did not meet dedup, scoring, or cap expectations.",
  };
}

export function judgePlanningConsistency(fixture: EvalFixture): StageEvalResult {
  const requirements: PlanningDocument["requirements"] = [
    {
      id: "req-1",
      text: "Reconcile commerce payments and accounting records.",
      acceptanceCriteria: ["Mismatches are listed for review."],
    },
    {
      id: "req-2",
      text: "Prepare approval summaries for finance users.",
      acceptanceCriteria: ["Summaries include risks and next actions."],
    },
  ];
  const doc = (
    title: string,
    extra: string,
    requirementIds: string[] = ["req-1", "req-2"],
  ): PlanningDocument => ({
    title,
    requirements: title === "PRD" ? requirements : [],
    sections: [
      {
        heading: "Users and requirements",
        body: `Users, requirement details, success metrics, and risk handling for ${fixture.idea}. ${extra}`,
        sourceIds: [],
        requirementIds,
      },
      {
        heading: "Architecture and data",
        body: "Architecture, data model, integration boundaries, and security controls trace to the PRD.",
        sourceIds: [],
        requirementIds,
      },
      {
        heading: "Milestone sequence",
        body: "Milestone sequence with acceptance criteria and risk checks traces to the PRD.",
        sourceIds: [],
        requirementIds,
      },
      {
        heading: "Open questions",
        body: "Open questions are explicit.",
        sourceIds: [],
        requirementIds: [],
      },
      {
        heading: "Non-goals",
        body: "Non-goals are explicit.",
        sourceIds: [],
        requirementIds: [],
      },
    ],
    risks: fixture.expected.risks,
    openQuestions: [],
  });
  const result = checkCrossDocumentConsistency(
    doc("PRD", "PRD"),
    doc("TRD", "TRD PRD"),
    doc("Build Plan", "Build plan PRD"),
  );
  const missingBuild = checkCrossDocumentConsistency(
    doc("PRD", "PRD"),
    doc("TRD", "TRD PRD"),
    doc("Build Plan", "Build plan PRD", ["req-1"]),
  );
  const passed =
    result.passed &&
    !missingBuild.passed &&
    missingBuild.issues.includes("req-2 not covered by build plan.");
  return {
    fixtureId: fixture.id,
    stage: "planning",
    score: passed ? 5 : 2,
    passed,
    notes: passed
      ? "Requirement-ID coverage checks passed and named a missing build-plan requirement."
      : [...result.issues, ...missingBuild.issues].join("; "),
  };
}

export async function judgeEvaluatorLoopRefinement(): Promise<StageEvalResult> {
  const rubric: Rubric = {
    id: "loop-regression",
    passingScore: 4,
    criteria: ["quality"],
  };
  const provider = {
    id: "gemini-2.5-flash" as const,
    generate: async () => {
      throw new Error("The deterministic loop eval should not call the provider.");
    },
  };

  const project = makeEvalProject("eval-loop-pass");
  const audit = new AuditLogger(project.id, ".jantra/eval-audit");
  let critiqueCount = 0;
  let refineCount = 0;
  const passing = await runEvaluatorLoop<string>({
    audit,
    project,
    stage: "research",
    provider,
    rubric,
    maxRounds: 2,
    generate: async () => "draft-1",
    critique: async (draft) => {
      critiqueCount++;
      const score = draft === "draft-2" ? 5 : 2;
      return {
        draft,
        feedback: score >= 4 ? "passed" : "needs refinement",
        eval: makeEvalScore(rubric, { quality: score }, `round ${critiqueCount}`),
      };
    },
    refine: async () => {
      refineCount++;
      return "draft-2";
    },
  });

  const failingProject = makeEvalProject("eval-loop-fail");
  const failingAudit = new AuditLogger(failingProject.id, ".jantra/eval-audit");
  let failedClosed = false;
  try {
    await runEvaluatorLoop<string>({
      audit: failingAudit,
      project: failingProject,
      stage: "research",
      provider,
      rubric,
      maxRounds: 2,
      generate: async () => "weak",
      critique: async (draft) => ({
        draft,
        feedback: "still weak",
        eval: makeEvalScore(rubric, { quality: 2 }, "weak"),
      }),
      refine: async (draft) => `${draft}-refined`,
    });
  } catch (err) {
    failedClosed = err instanceof StageFailedClosedError;
  }

  const passed =
    passing.draft === "draft-2" &&
    passing.eval.passed &&
    critiqueCount === 2 &&
    refineCount === 1 &&
    project.stages["research"]?.evals.length === 2 &&
    failedClosed;

  return {
    fixtureId: "evaluator-loop",
    stage: "research",
    score: passed ? 5 : 1,
    passed,
    notes: passed
      ? "Evaluator loop refines after a failed first critique and fails closed after max rounds."
      : "Evaluator loop did not record the expected refine or fail-closed behavior.",
  };
}

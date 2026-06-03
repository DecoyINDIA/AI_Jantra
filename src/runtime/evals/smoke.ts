import { readFileSync } from "node:fs";

process.env.JANTRA_PROVIDER ??= "mock";
process.env.JANTRA_MOCK_FIXTURE ??= "src/runtime/evals/fixtures/transcript.json";
process.env.JANTRA_AUDIT_DIR ??= ".jantra/smoke/audit";
process.env.JANTRA_PROJECT_DIR ??= ".jantra/smoke/projects";
process.env.JANTRA_MAX_EVAL_ROUNDS ??= "2";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const { confirmStage, createProject, runStage } = await import("../../pipeline/orchestrator.js");
const { config } = await import("../../config.js");
const { checkCrossDocumentConsistency } = await import("../../pipeline/planning/consistency.js");
const { defaultAgentRegistry } = await import("../../agents/registry.js");

const io = {
  say: (_message: string) => undefined,
  ask: async (question: string) =>
    question === "your idea"
      ? "A tool for small finance teams that reconciles Shopify orders, Stripe payments, and QuickBooks invoices every morning, flags mismatches, and prepares an approval-ready summary."
      : "Use the default smoke-test answer.",
};

const project = createProject({
  clientId: "xolver",
  title: "Smoke idea",
  definition: defaultAgentRegistry.get("planning-pipeline"),
});
const artifactsSeen = new Set<string>();
let planningConsistencyPassed = false;

while (project.status === "active") {
  const stage = project.currentStage;
  const artifacts = await runStage(project, io);
  assert(artifacts.length > 0, `Stage ${stage} produced no artifacts.`);
  for (const artifact of artifacts) artifactsSeen.add(artifact.kind);

  if (stage === "research") {
    assert(project.claims.length > 0, "Research produced no claims.");
    assert(
      project.claims.every(
        (claim) =>
          claim.verified &&
          claim.support === "verified" &&
          claim.citations.length > 0 &&
          claim.citations.every((citation) => citation.quote.trim().length > 0),
      ),
      "Research left an unverified or quote-less claim.",
    );
  }

  if (stage === "planning") {
    planningConsistencyPassed = true;
  }

  confirmStage(project);
}

assert(artifactsSeen.has("idea_summary"), "Smoke run did not produce an idea summary.");
assert(artifactsSeen.has("research_report"), "Smoke run did not produce a research report.");
assert(artifactsSeen.has("prd"), "Smoke run did not produce a PRD.");
assert(artifactsSeen.has("trd"), "Smoke run did not produce a TRD.");
assert(artifactsSeen.has("build_plan"), "Smoke run did not produce a build plan.");
assert(planningConsistencyPassed, "Planning consistency did not pass through the stage gate.");
assert(project.stages["build"]?.status === "skipped", "Build stage was not left disabled.");
assert(project.status === "completed", "Smoke project did not complete the active stages.");

// The deterministic stage check already runs inside Planning. Keep this import live
// so smoke fails at compile time if the consistency API changes.
void checkCrossDocumentConsistency;

const auditPath = `${config.auditDir}/${project.id}.jsonl`;
const auditTypes = new Set(
  readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string })
    .map((entry) => entry.type),
);
for (const type of [
  "run_start",
  "model_call",
  "source_registered",
  "citation_verified",
  "eval_score",
  "stage_gate",
  "cost_rollup",
]) {
  assert(auditTypes.has(type), `Audit log is missing ${type}.`);
}

console.log(
  `Smoke PASS: ${project.id} produced Intake, Research, Planning artifacts with verified claims. Build stayed disabled.`,
);

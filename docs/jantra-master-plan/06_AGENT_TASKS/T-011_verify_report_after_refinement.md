# TASK ID: T-011

**Title:** Verify the research report after refinement
**Priority:** P1
**Objective:** The final research report cannot contain a figure or a source reference that was not present in the verified claims; if refinement introduces one, the unrefined verified draft is used instead and the event is audited.
**Why This Matters:** `refineReport` lets a model rewrite the report after claims were verified, and the final check looks only at the claim list (Audit A-08). "Ground or abstain" is the product's central promise.
**Prerequisites:** none.
**Effort & Complexity:** Medium; high reasoning (false positives must be controlled).
**Recommended Agent Tier:** Advanced agent required. Independent review required.

---

## Standalone Execution Prompt

```
You are implementing task T-011 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/pipeline/stages/research.ts:
    renderReport(idea, viability, synthesized, anchorFit, sources) → deterministic markdown from verified data.
    critiqueReport / refineReport(ctx, report, critique, claims) → model rewrite (lines ~553-590).
    runResearch runs runEvaluatorLoop({ generate: () => renderReport(...), critique, refine, … }) and then
    builds the artifact from evaluated.draft (lines ~700-735), followed by runArtifactOutputChecks(artifact, claims).
- src/runtime/evaluator.ts: runEvaluatorLoop returns { draft, eval }.
- Claim (src/pipeline/types.ts): { text, citations: [{sourceId, quote}], sourceIds, verified, support }.
- A working precedent exists for ops reports in src/pipeline/stages/opsReporting.ts:
    extractNumbersFromText(text): Set<number>   (line ~414)
    verifyNumberProvenance(report, validNumbers): { valid, orphanNumbers }   (line ~479)
  Read both before writing anything; reuse their normalisation approach.
- Source ids appear in report text in a bracketed form produced by renderReport / sourceAppendix
  (src/pipeline/research/citationVerifier.ts, sourceAppendix). Open renderReport to see the exact pattern
  before writing the regex; do not assume.

FILES TO CREATE / MODIFY
- src/pipeline/research/reportProvenance.ts (new)
- src/pipeline/stages/research.ts
- src/audit.ts only if you need a new AuditType (prefer the existing "guardrail_block")
- src/runtime/evals/regressions.ts

INTERFACE
// src/pipeline/research/reportProvenance.ts
export interface ProvenanceResult { ok: boolean; orphanNumbers: string[]; unknownSourceRefs: string[]; }
export function checkReportProvenance(args: {
  finalReport: string;          // text after refinement
  baselineReport: string;       // renderReport output before any refinement
  verifiedClaims: Claim[];      // claims with verified === true
  knownSourceIds: string[];
}): ProvenanceResult;

ALGORITHM
1. allowedNumbers = numbers extracted from baselineReport ∪ numbers extracted from every verified claim's text
   and citation quotes. Extraction rule (write it once, test it):
     - match /\d[\d,]*(?:\.\d+)?/g, strip commas, keep as canonical string via String(Number(x));
     - ignore integers 0-12 (ordinals, list numbering, "3 risks") and four-digit years 1990-2100 only when
       they also occur anywhere in baselineReport (years absent from the baseline are NOT ignored);
     - ignore numbers inside markdown link targets and inside source-reference brackets.
   A number in finalReport is an orphan if its canonical form is not in allowedNumbers. Percent signs,
   currency symbols and unit suffixes (k, M, B, bn, million, billion) are not part of the number; "4.2M" → "4.2".
2. unknownSourceRefs = source references in finalReport (pattern taken from renderReport) whose id is not in
   knownSourceIds.
3. ok = orphanNumbers.length === 0 && unknownSourceRefs.length === 0.

IMPLEMENTATION STEPS
1. Write reportProvenance.ts per the interface and algorithm. Pure, no I/O.
2. In runResearch:
   a. Compute `const baseline = renderReport(idea, viability, synthesized, anchorFit, ctx.project.sources);`
      once, before runEvaluatorLoop, and pass `generate: async () => baseline`.
   b. After the loop: 
        const provenance = checkReportProvenance({ finalReport: evaluated.draft, baselineReport: baseline,
          verifiedClaims: claims.filter((c) => c.verified), knownSourceIds: ctx.project.sources.map((s) => s.id) });
        let finalDraft = evaluated.draft;
        if (!provenance.ok) {
          ctx.audit.record("guardrail_block", { clientId: ctx.project.clientId, projectId: ctx.project.id,
            stage: ctx.stageId, reason: "Refined report introduced unverified figures or sources; reverted to verified draft.",
            flags: ["post_refine_provenance"], orphanNumbers: provenance.orphanNumbers.slice(0, 20),
            unknownSourceRefs: provenance.unknownSourceRefs.slice(0, 20) });
          finalDraft = baseline;
        }
      Use finalDraft as the artifact content. Keep `eval: evaluated.eval` and add to the eval notes (string
      concatenation on a copy) " Reverted to verified draft after provenance check." when reverted.
   c. Leave the existing runArtifactOutputChecks / fail-closed block as is.
3. Regressions:
   - "report-provenance-unit": table-driven checks on checkReportProvenance:
       baseline "Market is $4.2 billion [S1]." + final "Market is $4.2B and grows 31% [S1]." → orphan ["31"]
       final equal to baseline → ok
       final cites a source id not in knownSourceIds → unknownSourceRefs has it
       final "There are 3 key risks." with no 3 in baseline → ok (small integers ignored)
       final "In 2031 the market…" with 2031 absent from baseline → orphan ["2031"]
       final "1,200 users" with baseline "1200 users" → ok
   - "report-provenance-revert": call the new logic through a small exported function
     `finalizeResearchDraft(baseline, refined, claims, sourceIds, audit, meta)` that encapsulates step 2b
     (export it from research.ts and use it in runResearch), with refined containing an invented number;
     assert the returned text === baseline and the AuditLogger recorded a guardrail_block with flag
     "post_refine_provenance".

EDGE CASES
- Refiner removes content: allowed.
- Refiner reformats a number ("4,200,000" ↔ "4.2 million"): this WILL be flagged ("4.2" vs "4200000") unless
  one of the forms is in allowedNumbers. Accept the revert in that case — reverting to the verified draft is
  always safe. Do not add fuzzy unit conversion.
- Empty claims list: allowedNumbers comes from the baseline only.

NON-GOALS: no change to claim verification, the skeptic pass, prompts, or planning; no semantic/LLM check.

ACCEPTANCE CRITERIA
1. npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0.
2. Both regressions pass.
3. npm run smoke still produces a research_report artifact (mock transcript). If the mock refined draft is now
   reverted, that is acceptable; record it under DEVIATIONS with the orphan list.

RISK & ROLLBACK: more reports fall back to the unrefined draft (less polished, still correct). Measure the
revert rate from audit logs after a week. Revert the commit to roll back.

ESCALATION CONDITIONS — stop and report if renderReport is not deterministic (contains timestamps or random
ids that would differ between two calls), or if source references in the report have no stable textual pattern.

Finish with the report format from 07_AGENT_CONTEXT.md.
```

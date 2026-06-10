# Dynamic Workflows — Implementation Brief

**Target:** Jantra AI pipeline (`D:\XOLVER\Mainframe`)
**For:** AI builders, Codex, or any agent picking this up cold
**Scope:** Three workflow upgrades to the existing 3-stage pipeline. Do not touch Intake. Do not break human gates. Maintain all existing audit, cost, and citation contracts.

---

## Context

Jantra runs a sequential pipeline: Intake → Research → Planning. Each stage is a `StageRunner` registered in `src/agents/runners.ts`, receives a `StageContext`, and returns `Artifact[]`. State persists to `project.execution[stageId]` via `PersistedStageState`. Cost accumulates to `project.cost` via `applyModelCost()`.

The existing `runEvaluatorLoop()` in `src/runtime/evaluator.ts` already handles generate → critique → refine cycles. Build on that, don't replace it.

---

## Upgrade 1 — Parallel Research Fan-Out

**File:** `src/pipeline/stages/research.ts`

**What to change:** The research stage currently executes each `ResearchPlan` dimension sequentially. Convert it to parallel execution where each dimension spawns its own isolated model call.

**ResearchPlan dimensions** (from `src/pipeline/research/schemas.ts`):
```typescript
type ResearchPlan = {
  market_demand: string[];
  competitive_landscape: string[];
  viability_assessment: string[];
  regulatory_legal: string[];
  technical_feasibility: string[];
}
```

**Implementation:**
- For each key in `ResearchPlan`, run the search + `SectionClaims` synthesis concurrently (e.g. `Promise.all`)
- Each parallel call should be scoped tightly: only receives its own queries, not the full plan
- After all dimensions resolve, a single synthesis step merges all `SectionClaims` into the final research artifact
- Persist intermediate per-dimension results to `project.execution[stageId].data` so the stage is reentrant if interrupted

**Token impact:** Neutral. Same total work, parallelized. Small orchestration overhead only.

**Do not change:** `Source`, `Claim`, `ClaimCitation` shapes. `citationVerifier.ts` contract. `CostRollup` accumulation logic.

---

## Upgrade 2 — Adversarial Citation Verification

**File:** `src/pipeline/research/citationVerifier.ts`

**What to change:** Currently the same model pass that generates claims also verifies them (self-preferential bias). Add a second, independent skeptic pass per claim.

**Existing Claim shape** (`src/pipeline/types.ts`):
```typescript
interface Claim {
  text: string;
  citations: ClaimCitation[];
  sourceIds: string[];
  verified: boolean;
  support: "verified" | "unverified";
}
```

**Implementation:**
- After the existing verification pass, run a second pass: for each `Claim` where `verified === true`, spawn an independent skeptic call
- Skeptic prompt: given the claim text and its citations, find any contradiction, misrepresentation, or unsupported extrapolation in the source quote
- Skeptic returns `{ refuted: boolean, reason?: string }`
- A claim survives only if `refuted === false`; otherwise flip `claim.verified = false` and `claim.support = "unverified"`, log the reason to the audit trail
- Run skeptic calls concurrently across all verified claims (`Promise.all`)
- Use a lighter/cheaper model for skeptic calls if the provider abstraction allows — skeptics only need the claim text and the citation quote, no full context

**Token impact:** Additive (~30-50% on research stage). This is the only upgrade that adds net-new work.

**Do not change:** The `Claim` interface shape. Downstream consumers read `claim.verified` and `claim.support` — those fields must remain and mean the same thing.

---

## Upgrade 3 — Planning Tournament

**File:** `src/pipeline/stages/planning.ts`

**What to change:** Currently generates a single plan and runs it through the evaluator rubric. Replace with a tournament: generate N variants, score each, synthesize the winner.

**Existing evaluator interface** (`src/runtime/evaluator.ts`):
```typescript
runEvaluatorLoop({
  generate: () => Promise<TDraft>,
  critique: (draft, provider) => Promise<Critique<TDraft>>,
  refine: (draft, critique) => Promise<TDraft>,
  maxRounds: number,
  rubric: Rubric
}) → { draft: TDraft; eval: EvalScore }
```

**Implementation:**
- Generate 3 plan variants concurrently, each with a different framing directive passed in the prompt:
  - `"conservative"` — minimize scope, maximize confidence, flag unknowns explicitly
  - `"balanced"` — default current behavior
  - `"ambitious"` — maximize opportunity surface, flag risks separately
- For each variant, run the existing `critique` step independently (3 concurrent critique calls)
- Score each variant against the rubric; select the variant with the highest `EvalScore`
- Run a final synthesis step: take the winning variant as the base, extract the 2-3 strongest elements from each losing variant, instruct the model to graft them onto the winner
- The synthesized output is the final `Artifact` — same shape as today, `kind: "plan"`

**Token impact:** ~2-3x on the planning stage only. Planning is a small fraction of total pipeline cost so overall impact is modest.

**Do not change:** `Artifact` shape. `gate: "human"` on the planning stage — the human still approves the final synthesized plan. `EvalScore` stored on the artifact's `eval` field should reflect the winning variant's score.

---

## Constraints (apply to all three upgrades)

- All `StageContext` fields must be threaded through to every parallel call: `audit`, `provider`, `store`
- Every model call must flow through `provider.ts` — no direct model instantiation
- Cost from parallel calls must all accumulate to `project.cost.perStage[stageId]` — don't lose tokens to parallel branches
- If any parallel branch throws, catch it, log to `audit`, and continue with the successful branches (fail open on fan-out, fail closed on adversarial verification)
- No new top-level files unless a helper genuinely can't live in the existing file; prefer extending existing modules
- No changes to `src/pipeline/types.ts` interfaces — downstream consumers (web UI, client SDK) depend on the shapes being stable

---

## Files to touch

| File | Change |
|------|--------|
| `src/pipeline/stages/research.ts` | Fan-out parallel execution |
| `src/pipeline/research/citationVerifier.ts` | Add adversarial skeptic pass |
| `src/pipeline/stages/planning.ts` | Tournament generation + synthesis |

**Do not touch:** `src/pipeline/orchestrator.ts`, `src/agents/definition.ts`, `src/pipeline/types.ts`, `src/runtime/evaluator.ts`, anything in `web/` or `desktop/`.

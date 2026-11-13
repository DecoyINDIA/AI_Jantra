# TASK ID: T-010

**Title:** Persist research checkpoints
**Priority:** P1
**Objective:** After each research checkpoint the project (including accumulated cost) is written to the store, so a crash or restart resumes instead of repeating paid work.
**Why This Matters:** `saveStageExecutionState` only changes memory; no stage calls the store. A crash mid-research loses all section results and the spend already incurred is never recorded (Audit A-09).
**Prerequisites:** none.
**Effort & Complexity:** Small; low reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-010 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/pipeline/executionState.ts: saveStageExecutionState(project, stageId, state) sets
  project.execution[stageId] = state in memory only.
- src/pipeline/stages/research.ts, runResearch (starts line 593):
    line ~606: after planResearch → state.data.plan = plan; saveStageExecutionState(...)
    line ~672: inside the per-section Promise.all branch, after synthesizeSection →
               state.data[key] = { synthesized, sources }; saveStageExecutionState(...)
  On re-entry it reuses state.data.plan and state.data[key] if present (lines 599-620).
- ctx.store is a ProjectStore; ctx.store.saveProject(ctx.project) is synchronous and safe to call repeatedly.
- Sections run concurrently in one event loop; saveProject is synchronous, so interleaving cannot corrupt it.
- src/pipeline/orchestrator.ts advanceStage: a stage found in status "in_progress" is allowed to run again
  (only awaiting_confirmation / confirmed / skipped are refused), so a restart re-enters runResearch with
  whatever was persisted.

FILES TO MODIFY: src/pipeline/stages/research.ts, src/runtime/evals/regressions.ts

IMPLEMENTATION STEPS
1. In research.ts add a local helper near the top-level helpers:
     function checkpoint(ctx: StageContext, state: PersistedStageState): void {
       saveStageExecutionState(ctx.project, ctx.stageId, state);
       ctx.project.updatedAt = new Date().toISOString();
       ctx.store.saveProject(ctx.project);
     }
   (import the PersistedStageState type from "../types.js" if not already imported).
2. Replace the two saveStageExecutionState(...) calls in runResearch with checkpoint(ctx, state).
3. Regression "research-checkpoint-persisted": use a counting store wrapper
     const base = new JsonProjectStore(); let saves = 0;
     const store = { ...methods delegating to base..., saveProject(p) { saves++; base.saveProject(p); } };
   Implement the wrapper as a small class that implements ProjectStore and forwards every method.
   Simplest reliable assertion without running the model: export `checkpoint` from research.ts (named export
   `checkpointResearchState`), call it with a minimal ctx ({ project, stageId: "research", store } cast as
   StageContext) and a state built by createStageExecutionState("research", "planning.research", { plan: {x:1} });
   then assert saves === 1 and base.loadProject(project.clientId, project.id)?.execution.research.data.plan
   deep-equals { x: 1 }.

EDGE CASES
- Do not call saveProject inside tight loops other than the two checkpoints.
- The saved project may contain partially filled `sources`; that is expected and already handled on re-entry.

NON-GOALS: no changes to intake, planning, ops or the re-entrant runners (the orchestrator already persists
after each of their steps); no change to executionState.ts; no job queue.

ACCEPTANCE CRITERIA: npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0;
the new regression passes; research.ts contains no direct saveStageExecutionState call inside runResearch.

RISK & ROLLBACK: slightly more disk writes (one per section, at most six per run). Revert to roll back.

ESCALATION CONDITIONS — stop and report if ctx.store is undefined in any existing caller of runResearch
(search for "runResearch(" in src/).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

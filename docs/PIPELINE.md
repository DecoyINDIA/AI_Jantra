# Onboarding Pipeline — design

The first thing we build on the Mainframe runtime, dogfooded on Xolver. It takes a client from a raw idea to a built product, through four stages with a human confirmation gate between each. It is, deliberately, the same workflow we run by hand: idea → research → plan → build.

> **Target:** all four stages. **Reality:** built and shipped incrementally. Stages 1–3 are fast, reliable wins. Stage 4 (build) is agentic coding with a human in the loop, not autonomous shipping. Each increment lands usable on its own.

## The pipeline

```
  ┌────────┐   gate   ┌──────────┐   gate   ┌──────────┐   gate   ┌────────┐
  │ Intake │ ───────► │ Research │ ───────► │ Planning │ ───────► │ Build  │
  └────────┘          └──────────┘          └──────────┘          └────────┘
   idea summary       market research       PRD + TRD +           working
                      report (cited)        build plan            software
```

A **gate** = the artifact is produced, then a human (the client, or Xolver) reviews and confirms before the next stage runs. This reuses the runtime's approval/handoff model: nothing proceeds without sign-off. Fail closed.

## Stages

| Stage | Input | Output artifact | How it works | Status |
|---|---|---|---|---|
| **1. Intake** | Client's raw idea | `idea_summary` (md) | Conversational agent: asks focused clarifying questions, then submits a structured summary via a tool. Multi-turn. | 🟡 Building |
| **2. Research** | Confirmed idea summary | `research_report` (md, cited) | Research agent: fan-out web search, fetch, synthesize. Competitors, market, validation, risks. | ⬜ Next |
| **3. Planning** | Idea + research | `prd`, `trd`, `build_plan` (md) | Document-generation agents from the confirmed inputs. | ⬜ Next |
| **4. Build** | PRD + TRD + build plan | working software (repo) | Hands to a coding agent with a human driver. Scaffolds and drafts; a person reviews, corrects, ships. | ⬜ Later (human-in-loop) |

## Data model

The unit that flows through the pipeline is a **Project** (one client engagement). Everything is scoped by `clientId` from day one so multi-tenancy is a later feature, not a rewrite (single-tenant now: `clientId = "xolver"`).

- `Project` — id, title, clientId, status, currentStage, per-stage state, timestamps.
- `StageState` — id, status (`pending | in_progress | awaiting_confirmation | confirmed | skipped`), artifacts.
- `Artifact` — stage, kind, title, markdown content, version, timestamp.

Persistence (MVP): JSON per project under `.mainframe/projects/<clientId>/`, plus each artifact written as a readable `.md` alongside it. A real database replaces this later (runtime requirement R7).

## Orchestration

- `createProject(clientId, title)` → new Project at stage `intake`.
- `runStage(project)` → dispatch to the stage's runner; produce artifacts; set stage to `awaiting_confirmation`.
- `confirmStage(project)` → mark confirmed, advance `currentStage` to the next stage (the gate).
- Stage runners share one interface (`StageContext`: project, audit logger, Claude client, and an `io` for asking/telling the user), so they are CLI-agnostic and testable. The interactive `io` is what a Slack/web approval UI plugs into later.

Every stage run is recorded in the runtime audit trail, so the whole engagement is auditable end to end.

## Build increments (how "all four" actually ships)

1. **Foundation + Stage 1** (this increment): pipeline types, store, orchestrator, gate model, and the Intake agent. Run end to end on the CLI, stop at the first gate.
2. **Stage 2 — Research:** wire web search/fetch tools; produce a cited report; gate it.
3. **Stage 3 — Planning:** generate PRD + TRD + build plan from confirmed inputs; gate them.
4. **Stage 4 — Build:** integrate a human-steered coding agent; scaffold from the build plan into a repo.
5. **Hardening:** persistence to a real DB, approval/handoff UI (Slack then web), multi-turn polish, tests.

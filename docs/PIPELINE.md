# Onboarding Pipeline — design

The first thing we build on the Jantra AI runtime, dogfooded on Xolver. It takes a client from a raw idea to a fully-planned product, through three stages with a human confirmation gate between each. It is, deliberately, the same workflow we run by hand: idea → research → plan.

> **Scope (decided 2026-06-03):** three stages — Intake → Research → Planning. The product is "bring an idea, get it back researched and fully planned." **Stage 4 (Build) is deferred** — it is the most expensive and least reliable part (agentic coding, human-in-the-loop), so it is out of scope until the planning product is proven. Built and shipped incrementally; each stage lands usable on its own.

## The pipeline

```
  ┌────────┐   gate   ┌──────────┐   gate   ┌──────────┐      ┌─ deferred ──┐
  │ Intake │ ───────► │ Research │ ───────► │ Planning │ ····►│    Build    │
  └────────┘          └──────────┘          └──────────┘      └─────────────┘
   idea summary       market research       PRD + TRD +        (out of scope
                      report (cited)        build plan          for now)
```

A **gate** = the artifact is produced, then a human (the client, or Xolver) reviews and confirms before the next stage runs. This reuses the runtime's approval/handoff model: nothing proceeds without sign-off. Fail closed.

## Stages

| Stage | Input | Output artifact | How it works | Status |
|---|---|---|---|---|
| **1. Intake** | Client's raw idea | `idea_summary` (md) | Conversational agent: asks focused clarifying questions, then submits a structured summary via a tool. Multi-turn. | 🟡 Building |
| **2. Research** | Confirmed idea summary | `research_report` (md, cited) | Research agent: fan-out web search, fetch, synthesize. Competitors, market, validation, risks. | ⬜ Next |
| **3. Planning** | Idea + research | `prd`, `trd`, `build_plan` (md) | Document-generation agents from the confirmed inputs. | ⬜ Next |
| ~~4. Build~~ | PRD + TRD + build plan | working software (repo) | **Deferred — out of scope.** Would hand to a coding agent with a human driver; revisit only after the planning product is proven. | ⏸️ Deferred |

## Data model

The unit that flows through the pipeline is a **Project** (one client engagement). Everything is scoped by `clientId` from day one so multi-tenancy is a later feature, not a rewrite (single-tenant now: `clientId = "xolver"`).

- `Project` — id, title, clientId, status, currentStage, per-stage state, timestamps.
- `StageState` — id, status (`pending | in_progress | awaiting_confirmation | confirmed | skipped`), artifacts.
- `Artifact` — stage, kind, title, markdown content, version, timestamp.

Persistence (MVP): JSON per project under `.jantra/projects/<clientId>/`, plus each artifact written as a readable `.md` alongside it. A real database replaces this later (runtime requirement R7).

## Orchestration

- `createProject(clientId, title)` → new Project at stage `intake`.
- `runStage(project)` → dispatch to the stage's runner; produce artifacts; set stage to `awaiting_confirmation`.
- `confirmStage(project)` → mark confirmed, advance `currentStage` to the next stage (the gate).
- Stage runners share one interface (`StageContext`: project, audit logger, Claude client, and an `io` for asking/telling the user), so they are CLI-agnostic and testable. The interactive `io` is what a Slack/web approval UI plugs into later.

Every stage run is recorded in the runtime audit trail, so the whole engagement is auditable end to end.

## Build increments (how the planning pipeline ships)

1. **Foundation + Stage 1** (done): pipeline types, store, orchestrator, gate model, and the Intake agent. Run end to end on the CLI, stop at the first gate.
2. **Stage 2 — Research:** wire web search/fetch tools; produce a cited report; gate it.
3. **Stage 3 — Planning:** generate PRD + TRD + build plan from confirmed inputs; gate them.
4. **Hardening:** persistence to a real DB, approval/handoff UI (Slack then web), multi-turn polish, tests.

> Stage 4 (Build) is deferred (see Scope above). If revisited, it slots in after Planning as a human-steered coding agent. The `build` stage stays registered in the runtime as a deferred, not-implemented stage so the structure is ready, but it is not on the roadmap right now.

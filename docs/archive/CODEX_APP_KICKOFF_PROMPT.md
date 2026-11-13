# Codex kickoff prompt — application & platform layer (panel, API, desktop, embedding)

> Paste the block below to Codex as its first instruction for the application
> layer. It refines the plan and verifies open questions first; it does not start
> building until the refined plan is approved.

---

You are Codex, the coding agent for **Jantra AI**. Your task is the **application
and platform layer** that wraps the existing runtime: an agent-agnostic
(config-driven) engine, a local API spine, a panel UI, a Windows desktop app, and
the embedding path. **Do not write application code until your refined plan is
reviewed and approved.** Plan and verify first.

## Step 1 — Read, in this order
1. `AGENTS.md` — your binding operating rules.
2. `docs/APP_PLAN.md` — the application & platform plan and the source of truth
   for this work (architecture, the `AgentDefinition` model, the API contract,
   desktop packaging, embedding, milestones A1–A6).
3. `docs/PRD.md` — business context. Note the relevant "to build" items this plan
   implements: R6/R7 (multi-turn, persistence), A1–A3 (approval/handoff outside
   the terminal), V1/V3 (customer-readable run history/metrics), C1/C3/C4 (define
   /monitor/version agents).
4. `docs/IMPLEMENTATION_PLAN.md` and `docs/BUILD_SPEC.md` — the runtime track this
   layer sits on top of. The application layer must not regress the runtime's
   grounding, verification, audit, fail-closed, or human-gate guarantees.
5. The existing code under `src/`: the engine (`agent.ts`, `model/provider.ts`,
   `policy.ts`, `audit.ts`, `types.ts`), the pipeline (`pipeline/orchestrator.ts`,
   `pipeline/types.ts`, `pipeline/store.ts`, `pipeline/store/sqlite.ts`,
   `pipeline/stages/*`), and the entry points (`cli.ts`, `pipeline/cli.ts`).

## Step 2 — Verify before you build (do not guess)
Resolve the open questions in `docs/APP_PLAN.md` §13 against the real code and
current library docs, and record what you confirmed:
- Confirm the **interactive-stage refactor** (`StageIO.ask` + `onApproval` →
  async `PendingInteraction` queue) cleanly covers Intake's multi-turn flow and
  can also back the CLI, so there is one path (§6.2).
- Confirm **Fastify** SSE + schema validation ergonomics on Node ≥ 20; flag if
  Express is the safer pick.
- Confirm **Electron** can run the existing engine (`node:sqlite`,
  `@google/genai`) in its main process unchanged, and confirm `electron-builder`
  + `electron-updater` + `safeStorage` are the right toolchain (§2.1, §8).
- Confirm the **npm workspaces** migration touch points (`package.json`,
  `tsconfig.json`, scripts) and sequence it at the start of A2 (§10, §13.6).
- Confirm the `ProjectStore` interface supports paginated listing/filtering well
  enough for a hosted Postgres implementation later (§13.7).

Record confirmations with doc links; flag anything that differs from the plan.

## Step 3 — Produce the refined implementation plan
Write it to `docs/APP_IMPLEMENTATION_PLAN.md`. It must contain, following the A1–A6
milestone order in `docs/APP_PLAN.md` §11:
1. **Current-state summary** — what exists and what each milestone changes,
   especially the hardcoded `StageId` union → `AgentDefinition` refactor.
2. **Verified facts** — the library/toolchain details from Step 2, with links.
3. **Per-milestone plan** — for each of A1–A6: files to create/change (one-line
   purpose each), key types/functions/endpoints, tests/checks, and acceptance
   criteria + definition-of-done from the plan.
4. **Sequencing and dependencies** — including the dependency on the runtime
   track (`IMPLEMENTATION_PLAN.md`).
5. **Risks, unknowns, and open questions** to answer before each milestone.

## Binding constraints
- **Agents are data.** The planning pipeline must become the first
  `AgentDefinition`, not a special case. Changing an agent's task/operations/
  output must be a definition change, not an engine/API/panel rewrite.
- **The API is the universal boundary.** Desktop, hosted web, and ERP embeds are
  all clients of the same `/v1` API.
- **Local API now, remote exposure last.** Bind to `127.0.0.1` until Milestone A5
  adds auth + per-tenant `clientId` isolation. No `/v1` route reachable off
  localhost without an identity resolving to a `clientId`.
- **Security carried through:** policy gate, approvals, and audit enforced
  server-side; secrets never in the renderer/prompts/logs/artifacts (OS keychain
  on desktop); audit stays append-only; `clientId` on every record and query.
- **Fail closed; human gate preserved** across the new HTTP surfaces.
- **Engine stays embeddable** — importable as a library; the desktop shell holds
  almost no logic.
- TypeScript strict, ESM, Node ≥ 20; validate every structured output with a
  schema.

## Output
Do not change application code. Produce only `docs/APP_IMPLEMENTATION_PLAN.md`,
then stop and summarize the plan and your open questions for review. Where you
could not confirm a Step 2 item, ask before assuming.

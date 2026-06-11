# Agent Creation SOP

The standard operating procedure for creating a new agent on the Jantra runtime. This is the "agent creation skill": follow it top to bottom and you will produce an agent that meets the runtime's quality bar. Each phase ends with a checkpoint; do not move on until the checkpoint passes.

Companion documents: [AGENT_QUALITY_PLAYBOOK.md](AGENT_QUALITY_PLAYBOOK.md) (the quality bar and anti-patterns) and [AGENT_BUILDER_PLAN.md](AGENT_BUILDER_PLAN.md) (automating this SOP).

---

## Phase 0 - Decide whether this should be an agent at all

Answer these before writing anything. If any answer disqualifies the idea, stop.

1. **Is the task agentic?** It needs multiple steps, judgment calls, tool use, or verification loops. If a single well-crafted prompt or a deterministic script does the job, build that instead. Agents add latency, cost, and failure surface; they must pay for it.
2. **Is success verifiable?** You must be able to state, before building, how you will know an output is good: a rubric, a deterministic check, a human review criterion. "Looks reasonable" is not verifiable. If you cannot define the rubric, you do not understand the task yet.
3. **Does an existing agent cover it?** Check `src/agents/registry.ts`. Extending an existing definition (new stage, version bump) is usually cheaper and safer than a new agent.
4. **Who reviews the output, and when?** Every agent on this runtime has human gates by default. If nobody will ever review the output, question why the agent should run at all.

**Checkpoint 0:** you can state in one sentence each: what the agent does, who uses it, what artifact it produces, and how you will verify quality.

---

## Phase 1 - Write the Agent Spec

Fill in every field below before touching code. This template is deliberately exhaustive; "to be decided later" is not an allowed value. The spec lives in `docs/` next to the agent (e.g. `docs/agents/<agent-id>.md`) and is the single source of truth for reviewers and for the future Agent Builder.

### Agent Spec template

```markdown
# Agent Spec: <name>

## Identity
- id:                  kebab-case, stable forever (e.g. "planning-pipeline")
- name:                human-readable
- description:         one sentence, outcome-focused ("Turns X into Y")
- persona:             named character or "none". If user-facing, give it a name,
                       a voice, and 3 adjectives (e.g. Manthan: warm, curious, unhurried)
- version:             starts at 1

## Users and trust
- primary user:        who interacts with it
- reviewer:            who confirms gated artifacts
- clientScoped:        always true; state which clientId namespace
- trust boundary:      what untrusted content enters (web pages, user uploads,
                       third-party API responses) and how each is fenced

## Inputs and outputs
- inputs:              what starts a run (raw text, prior artifacts, files)
- artifacts:           every artifact kind it produces, with a one-line content
                       contract each (e.g. "idea_summary: markdown, sections X/Y/Z")
- output schemas:      Zod schema sketch for every structured output
- out of scope:        explicit list of things this agent must refuse or hand off

## Stages
For EACH stage:
- id, title, one-line description
- kind:                model-flow | tool-loop
- model tier:          flash | pro, and why (see Phase 2 rules)
- interactionMode:     none | reentrant, and why
- gate:                human | auto, and why (auto requires the eval+cost argument)
- artifact kinds produced
- tools used (exact tool names) or "none"
- rubric:              3-5 scored dimensions with pass threshold
- failure policy:      what makes this stage fail closed, what context the
                       failure carries
- max loop bounds:     critic follow-up rounds, retry counts, step ceilings

## Cost and limits
- per-run cost ceiling (USD)
- per-client daily ceiling if user-facing
- token budgets per model call (generator and critic separately)
- expected cost per happy-path run (estimate now, measure later)

## Risks
- prompt injection surfaces and mitigations
- worst plausible bad output and its blast radius
- irreversible actions (if any) and their approval flow

## Evals
- 3+ golden input/output pairs (seed the regression suite)
- 2+ adversarial cases (injection attempt, garbage input, contradictory input)
- 1+ abstention case (input where the correct behavior is to refuse or ask)
```

**Checkpoint 1:** the spec has no empty fields, and a second reader (human or agent) can restate what the agent does without asking you anything.

---

## Phase 2 - Decompose into stages

Stages are the unit of gating, costing, evaling, and resuming. Get the decomposition right and everything downstream is easier.

**Split into a new stage when any of these differ:**
- the artifact produced (one stage = one coherent artifact set)
- the model tier needed (cheap drafting vs expensive reasoning)
- the tools needed (least privilege: a stage gets only the tools it uses)
- the natural human review point (each gate should review one decision)
- the failure policy (research can abstain; planning cannot half-deliver)

**Do not split** purely for code organization (use functions inside one runner) or to create gates nobody will meaningfully review (gate fatigue makes every gate worthless).

**Decision rules:**
- `interactionMode: "reentrant"` only when the stage must ask the user questions mid-run and survive a server restart between question and answer (see `runIntakeReentrant` and `PersistedStageState` in `src/pipeline/types.ts`). Pure transforms over prior artifacts use `"none"`.
- `gate: "human"` is the default. `gate: "auto"` is allowed only when the stage has a rubric-backed eval and the orchestrator's conditional autonomy (`effectiveGate` in `src/pipeline/orchestrator.ts`) can downgrade it: auto-confirm happens only when the eval passed and the run is under its cost ceiling. Never design a stage that assumes its gate will be auto.
- Model tier: default `flash`. Use `pro` only where the rubric demonstrably fails on flash (measure with the eval harness, do not guess). Long-document synthesis and multi-constraint planning are typical pro cases; extraction, classification, and conversation are typical flash cases.
- Stage order is linear. If you think you need branching, you usually need either a richer single stage or two agents.

**Checkpoint 2:** for every stage you can answer "what single question does the human at this gate answer?" If the answer is "several unrelated things", split; if "nothing really", merge or set up the auto-gate argument.

---

## Phase 3 - Author the AgentDefinition

Create `src/agents/<agentId>.ts` exporting an `AgentDefinition` (see `src/agents/definition.ts` for the shape and `planningPipeline.ts` for the canonical example).

Rules:
- `runnerKind` follows the convention `<agentFamily>.<stage>` (e.g. `planning.intake`, `support.toolLoop`). It is a stable string key into the runner maps in `src/agents/runners.ts`; never reuse a key across different behaviors.
- `version` starts at 1. Any change to stage order, gates, artifact kinds, schemas, or runner behavior that would confuse an in-flight project requires a version bump. Definitions are snapshotted into projects (`snapshotDefinition`, `snapshotHash`), so old runs keep executing against the old shape; the bump protects new runs and makes audit trails honest.
- Register in `defaultAgentRegistry` (`src/agents/registry.ts`). Registration runs `validateDefinition`; fix validation errors, never weaken the validator.
- Keep future stages registered but `kind: "disabled"`, `enabled: false` (see the Build stage) rather than leaving them out, when the roadmap is known.

**Checkpoint 3:** `npm run typecheck` is clean and the agent appears in the registry list with the right stage count.

---

## Phase 4 - Implement the stage runners

Each stage gets a `StageRunner` (and a `ReentrantStageRunner` if `interactionMode` is reentrant), registered in the maps in `src/agents/runners.ts`. The contract is `(ctx: StageContext) => Promise<Artifact[]>`; the context gives you the project, stage definition snapshot, audit logger, model provider, IO, store, and the `rejectionReason` when re-running after a human rejection.

Hard requirements inside a runner:

1. **Provider only.** Model calls go through `ctx.provider`. Never import a vendor SDK.
2. **Audit every model call** with purpose tags (`generator`, `critic`, etc.) via the telemetry helpers (see `trackStageModelCall` usage in `src/pipeline/stages/intake.ts`). Tokens, cost, and thinking summaries must land in the audit trail.
3. **Schema-validate every structured output** with Zod. On parse failure, retry within bounds, then fail closed. Never `JSON.parse` and hope.
4. **Generator/critic loop.** Generate, critique against the stage rubric with a separate model call and a distinct critic prompt, apply bounded follow-up rounds (the intake stage caps at 2), then either attach the passing `EvalScore` to the artifact or throw `StageFailedClosedError` with the scores and notes as context.
5. **Honor `ctx.rejectionReason`.** A rerun after rejection must steer the regeneration with the reviewer's reason, not reproduce the same artifact.
6. **Bound every loop.** Critic rounds, tool steps, retries: all have explicit ceilings defined in the spec. An unbounded loop is a cost incident waiting to happen.
7. **Fail closed with context.** Throw typed errors (`src/runtime/errors.ts`) carrying enough detail that the human at the handoff can act without re-running. Never return a degraded artifact silently.
8. **Reentrant stages persist state.** Use `PersistedStageState` (step counter, messages, pending interaction id, data bag) so the stage resumes correctly after restart. Test the resume path, not just the straight-through path.
9. **No secrets, no PII leaks.** Nothing from `.env` enters prompts, artifacts, or audit fields. Untrusted fetched content is reference material, never instructions; fence it explicitly in the prompt.

**Checkpoint 4:** the runner runs end to end against the mock provider (`npm run smoke` pattern), the failure path throws a typed error with context, and the rerun-after-rejection path produces a different artifact.

---

## Phase 5 - Write the prompts

Prompts are product surface. Treat them like code: reviewed, versioned, tested.

- **System prompt structure:** persona and mission first, then behavioral rules, then the output contract, then explicit anti-instructions. Anti-instructions name the failure mode you are guarding against (the intake critic says "never penalize vagueness the founder could not resolve" because that exact failure happened). When you find a prompt bug, fix it with a named anti-instruction, not a vague "be careful".
- **One prompt, one job.** The generator prompt does not self-assess. The critic prompt does not rewrite. Mixing jobs degrades both.
- **Output contract is explicit:** field names, types, allowed values, and "return only JSON" where structured. The Zod schema and the prompt contract must match exactly; drift between them is a recurring bug class.
- **User-facing stages get the persona; internal stages get a plain contract.** Warmth in intake, precision in critics. Never let an internal critic's tone leak to the user.
- **Fence untrusted content** with explicit delimiters and a standing instruction that content inside the fence is data, never instructions. This is mandatory for anything fetched from the web.
- **Offer options, do not interrogate.** When a stage asks the user something, give 2-3 candidate answers as easy choices (the intake follow-up pattern). Cap follow-up questions per round.
- **No em dashes in user-facing copy** (house style).

**Checkpoint 5:** another builder can predict the output shape from reading the prompt alone, and every anti-instruction can be traced to a failure mode in the spec's risk list.

---

## Phase 6 - Rubric and critic

The rubric is the agent's definition of "good". It is declared in the spec (Phase 1) and enforced by the critic.

- 3-5 dimensions, each scored 1-5, with an explicit pass threshold per dimension (intake requires all four at 4+).
- Dimensions must be **independently judgeable** ("specificity" and "no invented details" can disagree) and **anchored** (the critic prompt explains what a 4 looks like, what not to penalize, and what counts as a pass despite imperfection).
- The critic returns scores, notes, and at most N follow-up actions. Follow-ups are spent within the bounded loop; when they run out, the stage fails closed with the scores attached.
- Prefer **deterministic checks over model judgment** wherever possible: citation resolution, schema completeness, length bounds, banned-claim detection are code, not critic opinion. The critic judges only what code cannot.
- The passing `EvalScore` is attached to the artifact (`Artifact.eval`); the orchestrator's conditional autonomy depends on it. A stage without a real rubric can never earn `gate: "auto"`.

**Checkpoint 6:** feed the critic a deliberately flawed artifact for each rubric dimension; it must fail the right dimension with a note a human would agree with.

---

## Phase 7 - Tools (only if the agent needs them)

- Every tool has a spec with a name, description written for the model, input schema, and a risk class: read-only, reversible-write, irreversible.
- **Irreversible tools require an approval interaction** (the `PendingInteraction` approval flow). No exceptions, including "it's probably fine in this context".
- Least privilege: the stage's `toolNames` lists exactly the tools it uses. A research stage gets fetch and register-source, not send-email.
- Tool results from external systems are untrusted content: fence them (Phase 5) and run them through policy checks (`src/policy.ts`) before they influence artifacts.
- Tool failures are typed errors with retry/backoff, then fail closed. A tool silently returning empty is worse than a thrown error.

**Checkpoint 7:** the prompt-injection adversarial eval (Phase 1 spec) passes: a malicious instruction inside fetched content does not alter agent behavior.

---

## Phase 8 - Guardrails, cost, and audit

- Wire the stage into the policy layer: input guardrails (message length caps, injection detection) and output guardrails (artifact checks) per `src/policy.ts`.
- Set cost ceilings in config: per-run, and per-client daily for anything user-facing (see the intake budget pattern in `src/runtime/intakeBudget.ts` and the `JANTRA_*_CEILING_USD` env knobs). Ceiling breach is a fail-closed event, not a warning.
- Set explicit `maxOutputTokens` per call type (the intake stage budgets generator and critic separately).
- Verify the audit trail records: every model call with tokens and cost, every tool call, every guardrail decision, every gate event, every eval score, every handoff. If a debugging question about a run cannot be answered from the audit log alone, the logging is incomplete.

**Checkpoint 8:** run one happy-path project and reconstruct the entire run (every decision, every dollar) from `.jantra/audit` without looking at application logs.

---

## Phase 9 - Evals and tests

No agent ships without standing evals. The harness lives in `src/runtime/evals/`.

- Add the spec's golden cases to the regression suite (`regressions.ts` pattern), the adversarial cases, and the abstention case. Abstention evals matter most: an agent that never refuses is broken even when its outputs look good.
- Wire the stage into the judge where model-graded evaluation is needed (`judge.ts`, `modelJudge.ts`); prefer deterministic assertions where possible.
- The offline smoke path (`smoke.ts`, mock provider) must cover the new agent end to end, including the gate flow.
- Definition of done: `npm run typecheck` clean, `npm run eval` passing including the new cases, `npm run smoke` covering the new agent, cost rollup produced and within the spec's estimate, docs updated.

**Checkpoint 9:** break the agent on purpose (weaken a prompt, drop a schema field); the eval suite catches it. If it does not, the suite is decorative; fix it before shipping.

---

## Phase 10 - Rollout and lifecycle

- New agents launch with `autonomy: "gated"` and all gates `"human"`. Autonomy is proposed later, per stage, with eval pass-rate data attached.
- Version bumps: see Phase 3 rules. Document what changed and why in the agent's spec doc; in-flight projects continue on their snapshot.
- Watch the first N real runs in the audit trail: cost vs estimate, critic pass rates, gate rejection reasons. Every human rejection reason is free training data; fold recurring reasons back into prompts as anti-instructions and into the regression suite as new cases.
- Schedule a review after real usage: kill, keep, or improve. An unused agent is a maintenance liability; deregister it rather than letting it rot.

**Checkpoint 10:** the improvement loop is running: at least one prompt or rubric refinement has been derived from real rejection/audit data and captured as a regression eval.

---

## Quick-reference: full Definition of Done

- [ ] Phase 0 questions answered; agent justified
- [ ] Agent Spec complete, no empty fields, reviewed
- [ ] Stage decomposition passes the one-question-per-gate test
- [ ] Definition authored, validated, registered; typecheck clean
- [ ] Runners: provider-only, audited, schema-validated, generator/critic separated, bounded loops, fail-closed, rejection-aware, resume-tested
- [ ] Prompts: contract explicit, anti-instructions traceable, untrusted content fenced
- [ ] Rubric: independent anchored dimensions; critic catches planted flaws
- [ ] Tools: least privilege, approvals on irreversible, injection eval passes
- [ ] Guardrails and ceilings wired; audit reconstructs full runs
- [ ] Evals: golden + adversarial + abstention; suite catches planted regressions
- [ ] Launched gated; improvement loop active

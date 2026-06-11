# Agent Builder Plan

The plan for the meta-agent: an agent that builds other agents. It interviews the user about what the new agent should do, produces a complete design, gets explicit human confirmation, and then creates the agent. Status: **planned, not implemented**. Nothing in this document is built yet; it is the blueprint to build against.

Working name: **Nirmata** (the maker). Naming is a product decision; the id used below is `agent-builder`.

---

## 1. The core insight that makes this feasible

On this runtime an agent is already mostly data: an `AgentDefinition` is a declarative object (stages, gates, models, artifact kinds, schemas). The only part that is code today is the `StageRunner` behind each `runnerKind`, and an inspection of the existing runners shows they follow a small number of shapes (interview-then-summarize, research-with-citations, transform-prior-artifacts, tool-loop).

Therefore the builder strategy is **definition-as-data first, code-generation last**:

- Build a small library of **generic, parameterized runners** that cover the common shapes. A new agent then needs zero new code: it is a definition plus a "prompt pack" (persona, prompts, schemas, rubric, bounds) interpreted by generic runners.
- Only genuinely novel behavior requires generated TypeScript, and that path goes through a human pull-request review, never auto-activation.

This ordering is the whole plan. A builder that generates arbitrary code on day one is unsafe and unverifiable; a builder that emits validated data is neither.

---

## 2. Prerequisite groundwork (Phase 0, before the builder itself)

These are runtime features the builder needs. Each is independently useful.

### 2.1 Generic runner library

Parameterized `StageRunner`s registered under stable kinds, each driven entirely by a config object (the prompt pack):

| runnerKind | Shape | Parameters |
|---|---|---|
| `generic.conversation` | Reentrant interview that converges on a structured summary (the intake shape) | persona, system prompt, output schema, rubric, critic prompt, max follow-up rounds, question style rules |
| `generic.research` | Query fan-out, source registration, cited synthesis, deterministic citation verification (the research shape) | query strategy prompt, synthesis prompt, claim schema, source quality threshold, concurrency, abstention rules |
| `generic.transform` | Prior artifacts in, new artifact out, generator/critic loop, no user interaction (the planning shape) | input artifact kinds, generator prompt, output schema(s), rubric, critic prompt, candidate count (1 = single shot, N = tournament) |
| `generic.toolLoop` | Bounded tool-use loop with approvals (the support shape) | tool allowlist, system prompt, step ceiling, approval policy |

Design rules: generic runners enforce every SOP Phase 4 requirement structurally (audit, schema validation, bounded loops, fail-closed, rejection steering, resume for reentrant). The prompt pack cannot disable them. The prompt pack schema itself is versioned and Zod-validated.

### 2.2 Dynamic definitions and storage

- A **stored agent definition** format: the `AgentDefinition` plus the prompt packs, persisted under `.jantra/agents/<clientId>/<agentId>/v<version>.json` (same storage philosophy as projects; atomic writes; append-only versions, never edited in place).
- The `AgentRegistry` gains a load path for stored definitions alongside the built-in ones, with validation on load and client scoping enforced (a client only sees built-in agents plus its own).
- A **definition linter**: deterministic checks beyond `validateDefinition` - runnerKind exists, tool names resolve against the tool registry, schemas parse, rubric thresholds sane, ceilings present, every stage has bounds, prompt pack contracts match schemas. The linter is the builder's compile step.

### 2.3 Sandbox runs

A "dry run" mode that executes a stored definition end to end against the mock provider with synthetic inputs, producing artifacts and an audit trail but no cost and no persistence outside a scratch area. This is how a generated agent is smoke-tested before activation.

---

## 3. The builder agent itself

The builder is a Jantra agent, registered like any other, built by following the Agent Creation SOP (it is the SOP, automated). Dogfooding is deliberate: every runtime guarantee (gates, audit, cost ceilings, fail-closed) applies to the builder for free.

### Definition sketch

```
id: agent-builder           clientScoped: true        version: 1
stages:
  1. discovery   generic.conversation   reentrant   gate: human   flash
     artifact: agent_spec
  2. design      generic.transform      none        gate: human   pro
     artifacts: agent_design (definition draft + prompt packs + eval seeds)
  3. assembly    builder.assemble       none        gate: human   (mostly deterministic)
     artifacts: agent_bundle (validated stored definition + lint report + sandbox run report)
```

### Stage 1 - Discovery (the interview)

Interviews the user against the Agent Spec template from the SOP (Phase 1). The conversation runner's persona is a calm expert agent designer; its job is to fill every spec field, inferring what it can and asking only what it must, offering candidate answers as options.

Interview coverage (mapped one-to-one to the spec template): purpose and outcome; users and reviewers; inputs; every artifact and its contract; stage decomposition (proposed by the builder, confirmed by the user, using the SOP Phase 2 split rules); per-stage model tier, gate, interaction mode; tools and their risk classes; cost expectations; risks and injection surfaces; out-of-scope list; seed eval cases including at least one abstention case.

Critic rubric for `agent_spec`: completeness (no empty fields), coherence (stages produce what later stages consume), verifiability (every stage has a judgeable rubric), safety (risk fields are concrete, not boilerplate). Human gate: the user confirms the spec. **This is the user's first confirmation point.**

### Stage 2 - Design

Transforms the confirmed spec into a full `agent_design`:

- the `AgentDefinition` draft (stages mapped to generic runnerKinds wherever possible),
- a prompt pack per stage (persona, generator prompt, critic prompt, rubric with thresholds, schemas, bounds),
- eval seeds (golden, adversarial, abstention) in the harness fixture format,
- a one-page summary written for the human reviewer: what the agent does, what it can never do, what it costs, where its gates are.

Generation uses the tournament pattern (N candidate designs, judged against a design rubric). Deterministic post-checks run before the artifact is even offered: linter passes, schemas parse, prompt/schema contracts agree. Human gate: the user reviews the design summary. **Second confirmation point.** Rejection reasons steer regeneration per the standard rerun flow.

If any stage cannot be expressed with generic runners, the design stage says so explicitly and marks the agent as requiring the code-generation path (Phase 3 of the roadmap); it never silently approximates the behavior with the wrong runner shape.

### Stage 3 - Assembly and activation

Mostly deterministic (model calls only for fixing lint findings, bounded):

1. Assemble the stored-definition bundle; run the full linter.
2. Execute a sandbox run against the mock provider; attach the artifact and audit excerpts to the report.
3. Run the seeded evals in offline mode where possible.
4. Produce `agent_bundle` with the lint report and sandbox results. Human gate: the user sees evidence the agent actually runs before it goes live. **Final confirmation point.** On confirmation, the bundle is written to the agent store and the registry picks it up.

### Builder safety model (hard rules)

- Generated agents launch with `autonomy: "gated"` and every gate `"human"`, regardless of what the interview asked for. Autonomy is requested later, with eval data, through the normal process.
- The builder can only grant tools from a curated allowlist with risk classes; it can never mint new tools, and irreversible tools always carry the approval flow.
- The builder cannot weaken structural guarantees: generic runners keep audit, schema validation, bounds, and fail-closed regardless of prompt pack content.
- Prompt packs are scanned by the policy layer (injection patterns, secret-shaped strings) before storage.
- Generated agents are client-scoped to their creator; cost ceilings are mandatory fields with conservative defaults.
- The code-generation path (roadmap Phase 3) never auto-activates: it emits a branch and a PR that a human merges after `typecheck` and `eval` pass in CI.

### Evaluating the builder itself

The builder gets the same eval treatment as any agent, plus meta-evals:

- **Golden specs:** a set of agent requests (e.g. "competitor teardown agent", "support triage agent", "content brief agent") with reviewed reference designs; the builder's output is judged against them.
- **Round-trip test:** every generated agent must pass its own sandbox run and its own seeded evals. The builder's headline metric is "share of generated agents accepted at the design gate on the first attempt" and "share whose sandbox run passes without human fixes".
- **Adversarial requests:** the builder must refuse or constrain requests for agents that would violate hard rules (secret access, ungated irreversible tools, no verifiable output), with a clear explanation. Refusal cases are first-class evals.

---

## 4. Roadmap

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **0. Groundwork** | Generic runner library (conversation, transform first; research, toolLoop second), stored definitions + dynamic registry, definition linter, sandbox runs | An existing stage (intake) re-expressed as `generic.conversation` + prompt pack passes the current eval suite unchanged; a hand-written stored definition activates without code changes |
| **1. Builder MVP** | Discovery and Design stages; Assembly without code-gen; generic-runner agents only | A non-developer creates a working transform-style agent end to end through the three gates; the agent passes its sandbox run |
| **2. Quality depth** | Design tournaments, eval-seed generation, refusal handling, design-time cost estimation, builder meta-evals in CI | Golden-spec suite passing; first-attempt design acceptance measured and above an agreed bar |
| **3. Code generation** | Custom-runner scaffold generation following the SOP, PR-based review path, CI gating | A custom-stage agent ships via builder-generated PR with zero hand-written boilerplate and full eval coverage |
| **4. Lifecycle** | Editing existing agents (version bumps via the same interview/design/confirm flow), deprecation, usage analytics feeding the improvement loop, A/B between agent versions | An existing generated agent is revised through the builder with a clean version history and no disruption to in-flight projects |

Phases ship in order; the builder MVP is not started until both Phase 0 acceptance criteria pass, because the builder is only as safe as the linter and sandbox underneath it.

---

## 5. Decision points, with recommendations

Recorded so nothing is left to assumption. Each has a recommendation; overriding it is fine but should update this table.

| Decision | Recommendation | Rationale |
|---|---|---|
| Builder UI surface | Reuse the existing web run UI (it is just another agent with reentrant intake) | Zero new surface area; gates and interactions already render |
| Where stored definitions live | `.jantra/agents/` files first, database later if multi-instance | Matches project storage; atomic-write patterns already exist |
| Who can use the builder | Internal/admin first; per-client exposure only after Phase 2 meta-evals | Generated agents are product surface; quality bar first |
| Default model tiers in generated agents | flash everywhere; pro only where the design stage argues for it explicitly | SOP Phase 2 rule; cost discipline by default |
| Can generated agents use research/web tools | Not in MVP; enable with `generic.research` in late Phase 1 | Injection surface; ship the fenced, verified path, not ad-hoc fetching |
| Prompt pack format | Versioned JSON validated by Zod, stored beside the definition | Same trust rules as model output: schema or it does not exist |
| Naming/persona of the builder | "Nirmata", consistent with Jantra/Manthan naming | Persona consistency (playbook Part 2); final call is a product decision |

---

## 6. What this unlocks

Once Phase 1 lands, the marginal cost of a new agent drops from days of engineering to one gated conversation, while the floor on quality stays fixed because the SOP is enforced by machinery (linter, generic runners, sandbox, gates) rather than by discipline. The SOP document remains the source of truth for humans and for the builder's own prompts; when the SOP changes, the builder's design rubric changes with it.

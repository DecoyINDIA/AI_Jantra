# Agent Quality Playbook

The SOP tells you how to build an agent. This document tells you what separates a world-class agent from one that merely works. It is opinionated on purpose: these positions were earned from real failures in this codebase and from the broader state of the art, and an agent that violates them needs a written justification, not a shrug.

---

## Part 1 - The ten principles

### 1. Verification beats generation

The quality of an agent is set by its weakest verifier, not its strongest generator. A mediocre model with deterministic citation checking (the Research stage) outperforms a frontier model that grades its own homework. Budget engineering effort accordingly: for every hour spent on the generator prompt, expect to spend an hour on the rubric, critic, and deterministic checks. When choosing between a better generation prompt and a better verification step, take the verification step.

### 2. Ground or abstain

An agent that says "I could not verify this" is more valuable than one that fills the gap plausibly. Every factual claim needs a citation that resolves to a source the system actually retrieved, verified by code, not by the model. Where grounding is impossible, the agent records the gap honestly (the intake pattern: gaps go in `open_questions` and the critic is explicitly told that honest gaps are not penalized). Invented detail is the cardinal sin; it erodes the one thing the product sells, which is trust.

### 3. Generator and critic are different minds

No stage accepts its own first draft. The critic is a separate model call with its own prompt, its own purpose tag in the audit trail, and crucially its own perspective: it is told what the generator's job was, what failure modes to hunt, and what not to penalize. For wide solution spaces, go further: generate N candidates from genuinely different angles and run a tournament (the planning stage does this). Redundancy catches variance; diversity catches blind spots.

### 4. Fail closed, loudly, with context

Every failure path ends in a typed error carrying enough context for a human to act without re-running: the scores that failed, the claim that would not verify, the ceiling that was hit. The forbidden alternatives are: silently shipping a degraded artifact, retrying forever, or swallowing the error and continuing. A clean stop with a good handoff is a feature; users forgive "I could not do this safely" and never forgive confidently wrong.

### 5. Every loop has a number on it

Critic follow-up rounds, tool steps, retries, regeneration attempts: each has an explicit ceiling chosen at spec time and written down. The pattern "loop until good" without a bound is how an agent turns a bad input into a cost incident. When the bound is exhausted, fail closed (principle 4); do not lower the bar to exit the loop.

### 6. Autonomy is earned, never assumed

Human gates are the default and they are a product feature, not a temporary crutch. A stage earns `gate: "auto"` only with rubric-backed eval data, and even then the orchestrator downgrades to human when the eval fails or cost ceilings are threatened. Equally important: do not over-gate. A gate the reviewer rubber-stamps is worse than no gate, because it trains the reviewer to rubber-stamp the gates that matter. Each gate must put exactly one meaningful decision in front of the human.

### 7. Evals before prompts, regressions forever

Write the eval cases (golden, adversarial, abstention) before tuning the prompt; otherwise you are optimizing against your own impression of one lucky run. Every production bug, every human gate rejection, every weird audit-trail run becomes a regression case the day it is found. The eval suite is the agent's institutional memory; an agent whose suite has not grown in months is an agent nobody is learning from.

### 8. Cost is a design input, not a bill

Decide what a run should cost at spec time, enforce it with ceilings, and measure the real number from the audit trail. Model tier is chosen per stage by measured need (flash until evals prove pro is required), token budgets are set per call type, and ceiling breaches fail closed. An agent without a cost model is an agent without a business case.

### 9. The audit trail is the product's memory

If a question about a run ("why did it say this", "what did it cost", "who approved that") cannot be answered from the audit log alone, the logging is incomplete. Audit everything: model calls with tokens and cost, thinking summaries, tool calls, guardrail decisions, citations, eval scores, gate events, handoffs. This is also what makes improvement possible: prompt iteration driven by audit data beats prompt iteration driven by vibes.

### 10. The improvement loop is the moat

A world-class agent is not shipped; it is grown. The flywheel: real runs produce audit data and gate rejections; rejection reasons become anti-instructions in prompts and new regression evals; eval pass rates justify autonomy upgrades; autonomy produces more runs. Every piece of this loop already exists in the runtime (rejection feedback steers reruns, evals gate autonomy); the discipline is actually closing the loop on a schedule instead of moving on to the next agent.

---

## Part 2 - Craft details that compound

These are smaller than principles but separate the top agents from the median.

- **Persona is consistency, not decoration.** A user-facing persona (Manthan) has a name, a temperament, and rules of conduct that hold across every stage and every error message. The fastest way to break trust is a warm intake followed by a robotic failure message. Write the persona's error voice too.
- **Ask like a colleague, not a form.** When the agent needs input, it asks at most a couple of questions per round, offers candidate answers as easy options, and never asks what it could infer. Interrogation is a UX failure even when the questions are individually reasonable.
- **Schema and prompt must agree exactly.** Field-name or enum drift between the Zod schema and the prompt's output contract is a silent quality killer: the model complies with the prompt and the parser rejects it. Co-locate them and review them together.
- **Anti-instructions over platitudes.** "Be accurate" does nothing. "Never penalize vagueness the founder could not resolve" fixes a named failure mode. Every prompt rule should be traceable to a failure you have seen or specifically anticipate.
- **Deterministic before model-judged.** Length bounds, schema completeness, citation resolution, banned claims, URL liveness: all code. Spend model judgment only where code cannot reach (nuance, tone, relevance).
- **Resume is a first-class path.** Reentrant stages persist step, messages, and pending interaction; the run survives a restart between question and answer. Test the resume path explicitly; it is always the path that rots.
- **Concurrency safety is correctness.** Run locks around advance/confirm/reject (the `withRunLock` pattern), atomic file writes, idempotent resubmits returning 4xx for non-pending interactions. Agents are long-lived state machines; treat their state like money.
- **Untrusted content is radioactive.** Anything fetched or uploaded is fenced, policy-checked, and treated as data. The injection eval is mandatory, and "the model seemed to ignore the injection in my test" is not a mitigation.
- **Least privilege everywhere.** Stages list exactly the tools they use; irreversible tools require approval interactions; the agent never sees secrets. Capability you did not grant is capability you do not have to defend.
- **Write for the reviewer.** Artifacts are read by a human at a gate. Structure them so the gate decision is easy: lead with the conclusion, surface the uncertainties, link the evidence. An artifact that buries its weakest claim is optimizing against its own reviewer.

---

## Part 3 - Anti-patterns (what to avoid, by name)

| Anti-pattern | Why it kills quality | Do instead |
|---|---|---|
| Self-grading | Generator bias rubber-stamps its own output | Separate critic call with its own prompt (SOP Phase 6) |
| Kitchen-sink agent | One agent, twelve loosely related jobs; nothing verifiable | One outcome per agent; compose agents via stages |
| Unbounded loops | "Retry until good" becomes a cost incident | Explicit ceilings, then fail closed |
| Silent degradation | Shipping a weak artifact because the loop ran out | `StageFailedClosedError` with context |
| Gate fatigue | Gates nobody meaningfully reviews train rubber-stamping | One real decision per gate; merge or auto the rest |
| Vibes-driven prompting | Tuning against one lucky run | Evals first, regression suite forever |
| Prompt/schema drift | Model complies with prompt, parser rejects it | Co-locate schema and contract, review together |
| Invented specificity | Plausible filler where data is missing | Ground or abstain; honest `open_questions` |
| Vendor lock-in in stages | Stage imports an SDK, provider swap becomes a rewrite | All calls through the provider interface |
| Happy-path testing | Resume, rejection-rerun, and injection paths rot | Test failure, resume, and adversarial paths explicitly |
| Interrogation intake | Twenty questions before any value | Infer what you can, ask few, offer options |
| Secret leakage | Keys or PII in prompts/artifacts/audit | Secrets never enter the model boundary; audit truncation on |
| Hidden cost | No ceiling, no estimate, surprise bill | Cost model at spec time, ceilings enforced |
| Persona whiplash | Warm intake, robotic errors | Persona owns every message, including failures |
| Shipped-and-forgotten | No one reads the audit data; quality plateaus | Scheduled improvement loop (Part 1, #10) |

---

## Part 4 - Beyond the workflow: what makes these agents the best in the world

The workflow gets you correctness. World-class is a property of the system around the agents:

1. **A growing eval asset.** Treat the regression suite as the most valuable artifact in the repo. Competitors can copy prompts in an afternoon; they cannot copy two years of distilled failure cases.
2. **Rejection data as fuel.** Every human gate rejection is labeled training data that cost you nothing extra. Mine it monthly: recurring reasons become prompt anti-instructions, new rubric dimensions, or new deterministic checks.
3. **Per-stage model arbitrage.** The provider abstraction plus per-stage tiering means every model release is an opportunity, not a migration. Re-run the eval suite against new models quarterly; upgrade stages where the data says so, nowhere else.
4. **Trust as the visible feature.** Citations that resolve, costs that are itemized, gates that show their reasoning, refusals that explain themselves. Make the verification machinery visible in the product; it is the differentiator, not overhead.
5. **Abstention as a brand.** The agent that says "I do not know, here is what would settle it" earns the authority that makes its confident answers believed.
6. **Compounding memory.** Carry forward what gates taught the system about each client (vocabulary, preferences, standing constraints) so the tenth run is better than the first. Memory must be inspectable and editable by the client; silent memory is a trust bug.
7. **Time-to-trust as the north-star metric.** Track, per agent: eval pass rate, gate acceptance rate on first try, cost per accepted artifact, and how quickly a new client moves from gated to auto. Optimize these, in that order.

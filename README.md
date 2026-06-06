# Jantra AI runtime

Jantra AI is a reusable agent runtime plus a human-gated product planning pipeline. It turns a raw product idea into a build-ready plan through three active stages:

- Intake: clarify the idea and produce an idea summary.
- Research: gather cited market evidence, register sources, verify citations, and abstain when claims cannot be grounded.
- Planning: produce a PRD, TRD, and build plan from the accepted intake and research artifacts.

Stage 4, Build, is registered for future extension and remains disabled.

## What's here

```text
src/
  agent.ts                 provider-backed runtime loop with policy, audit, tools, and handoff
  model/                   Gemini 2.5 provider interface and Google Gen AI SDK adapter
  policy.ts                guardrails, prompt-injection detection, and artifact checks
  audit.ts                 append-only JSONL audit trail
  runtime/                 evaluator loop, telemetry, typed errors, and eval harness
  pipeline/                project/store/orchestrator plus Intake, Research, and Planning stages
  tools/                   reusable tool definitions for the support demo runtime
  cli.ts                   support demo runner
```

## Design choices

- Gemini 2.5 only: Flash or Pro is selected per stage through config. All model calls go through `src/model/provider.ts`.
- Generator and critic are separate passes: stages must satisfy their rubric before accepting an artifact.
- Ground or abstain: Research registers retrieved sources and verifies claim citations deterministically.
- Audit everything: model calls, thinking summaries, tokens, cost, tools, gates, guardrails, citations, eval scores, and handoffs are recorded.
- Fail closed: unverifiable claims, cost ceiling breaches, schema failures, and guardrail blocks stop the stage with context.
- Human gate between stages: the CLI gate is abstracted so Slack or web approval can replace it later.

## Run it

```bash
npm install
cp .env.example .env          # add GEMINI_API_KEY
npm run typecheck
npm run eval
npm run smoke                # offline full-pipeline check with the mock provider
npm run pipeline
```

The pipeline stores projects under `.jantra/projects` and audit logs under `.jantra/audit`.

Optional stage model overrides:

```bash
JANTRA_MODEL_INTAKE=flash
JANTRA_MODEL_RESEARCH=pro
JANTRA_MODEL_PLANNING=pro
JANTRA_COST_CEILING_USD=25
JANTRA_THINKING_BUDGET=4096  # tune to your cost profile; -1 enables dynamic thinking
JANTRA_RESEARCH_CONCURRENCY=4
JANTRA_SYNTHESIS_CONCURRENCY=3
JANTRA_MAX_SOURCES=24
JANTRA_EXPLICIT_CACHE=true
```

Research concurrency is capped in config to avoid accidental rate-limit spikes.
The smoke command sets `JANTRA_PROVIDER=mock` internally and does not require a
Gemini key.

## Status

This is the Jantra planning pipeline implementation target from `docs/BUILD_SPEC.md`. The eval harness runs without a Gemini key; live model-judge evals are skipped unless a key is present. Live pipeline runs require `GEMINI_API_KEY`.

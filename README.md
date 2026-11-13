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
  model/                   provider interface with Gemini, OpenAI-compatible, and mock adapters
  agents/                  agent definitions and registry (intake, planning, ops, support, concierge)
  policy.ts                guardrails, prompt-injection detection, and artifact checks
  audit.ts                 append-only JSONL audit trail
  runtime/                 evaluator loop, telemetry, budgets, typed errors, and eval harness
  pipeline/                project/store/orchestrator plus Intake, Research, Planning, and Ops stages
  server/                  Fastify API server with auth, tenancy, rate limiting, and routes
  tools/                   reusable tool definitions for the support demo runtime
  cli.ts                   support demo runner
web/                       React 19 + Vite operator web UI workspace
desktop/                   Electron desktop application workspace
packages/
  client/                  typed API client SDK workspace
  embed-widget/            public intake chat widget workspace
deploy/
  cloudflare-worker/       edge proxy worker script and configuration
```

## Design choices

- Providers: Gemini, any OpenAI-compatible endpoint, and mock. Stages never import a vendor SDK. Grounded research runs on Gemini.
- Generator and critic are separate passes: stages must satisfy their rubric before accepting an artifact.
- Ground or abstain: Research registers retrieved sources and verifies claim citations deterministically.
- Audit everything: model calls, thinking summaries, tokens, cost, tools, gates, guardrails, citations, eval scores, and handoffs are recorded.
- Fail closed: unverifiable claims, cost ceiling breaches, schema failures, and guardrail blocks stop the stage with context.
- Human gate between stages: the CLI gate is abstracted so Slack or web approval can replace it later.

## Run it

```bash
npm ci
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
JANTRA_INTAKE_RUN_CEILING_USD=0.25  # tune to your cost profile; 0 disables
JANTRA_INTAKE_CLIENT_DAILY_CEILING_USD=0.50  # tune to your cost profile; 0 disables
JANTRA_THINKING_BUDGET=4096  # tune to your cost profile; -1 enables dynamic thinking
JANTRA_AUDIT_MAX_FIELD_BYTES=16384  # tune to your cost profile; 0 disables truncation
JANTRA_MAX_USER_MESSAGE_CHARS=100000  # tune to your cost profile
JANTRA_RESEARCH_CONCURRENCY=4
JANTRA_SYNTHESIS_CONCURRENCY=3
JANTRA_MAX_SOURCES=24
JANTRA_EXPLICIT_CACHE=true
```

Research concurrency is capped in config to avoid accidental rate-limit spikes.
Explicit Gemini caches default to a short 10 minute TTL; callers that hold a
`GeminiProvider` can call `dispose()` to delete tracked cache handles early.
The smoke command sets `JANTRA_PROVIDER=mock` internally and does not require a
Gemini key.

## Status

Agent readiness:
- **Production:** `intake-public` (anonymous visitor intake widget deployed on xolver.in capturing leads)
- **Usable:** `planning-pipeline` (human-gated 3-stage intake -> research -> planning pipeline)
- **Prototype:** `ops-onboarding`, `ops-reporting` (reporting does not send reports and needs real partner data)
- **Demo:** `support-agent` (sample interactive support demo)
- **Client-specific:** `firebnb-concierge` (hospitality concierge agent)

The eval harness runs without a Gemini key; live model-judge evals are skipped unless a key is present. Live pipeline runs require `GEMINI_API_KEY`.

The [master planning package](docs/jantra-master-plan/README.md) contains the audit, roadmap, task packets, and owner decisions recorded on 2026-11-13.

## Render deployment

`render.yaml` defines the Singapore starter web service and a 1 GB persistent disk mounted at `/data/jantra`. The service exposes the unauthenticated, side-effect-free `/health` readiness route; all `/v1` application routes keep their existing authentication.

Keep `JANTRA_DATA_DIR=/data/jantra`, `JANTRA_PROJECT_DIR=/data/jantra/projects`, `JANTRA_AUDIT_DIR=/data/jantra/audit`, `JANTRA_LEAD_DIR=/data/jantra/leads`, and `JANTRA_OPS_DATA_DIR=/data/jantra/ops`. Captured leads, run state, audit logs, and ops CSV data are persisted under `/data/jantra` on the mounted disk. Note that existing local setups with CSVs under `data/ops` must set `JANTRA_OPS_DATA_DIR=data/ops` or move the folder to `.jantra/ops`. Configure the provider, model, API-key, admin-token, service-token, and cost-ceiling variable names declared in the Blueprint through Render without committing their values.

Before cutover, copy the current Railway `/data/jantra` volume into the Render disk during a brief write pause. Validate SQLite files with `PRAGMA integrity_check`, compare file counts/checksums, then test `/health`, an authenticated agent listing, an existing read-only run lookup, and an intake request. Keep Railway and its volume intact until the rollback window closes. Roll back by directing the intake proxy to the Railway origin; reconcile any writes made on Render before reopening Railway for writes.

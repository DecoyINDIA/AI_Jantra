---
name: project-state
description: Current implementation state of Jantra — what is built, what is uncommitted, and what is next
metadata:
  type: project
---

## What is Jantra

Jantra is an AI-pipeline backend (TypeScript / Fastify) that orchestrates multi-stage LLM research and planning runs. It has a React web UI, a desktop wrapper, a CLI, and a remote-deploy mode (Railway / Cloudflare edge).

Core runtime path: `POST /v1/runs` → `createProject` (orchestrator) → `advanceStage` → `StageRunner` (per-stage handler) → `ModelProvider.generate` → artifacts saved to project store → server-sent events to UI.

## Uncommitted changes as of 2026-06-10

All changes below are local, NOT yet committed to `main`.

### Layer 1 — OpenAI-compatible provider

**Files changed:**
- `src/model/openaiCompatible.ts` *(new)* — `OpenAICompatibleProvider` using `fetch` against any `/chat/completions` endpoint (OpenRouter, OpenAI, DeepSeek, Groq, Ollama etc). Handles message mapping, tool calls, JSON-schema response format, reasoning capture, grounded-call delegation to Gemini.
- `src/model/index.ts` — factory branch for `provider === "openai-compatible"`.
- `src/model/provider.ts` — loosened types (`provider` union, `modelId: string`).
- `src/config.ts` — `providerFromEnv()` accepts `"openai-compatible"`; new fields `baseUrl`, `llmApiKey`, `llmModelFlash`, `llmModelPro`, `llmPriceInputPerMillion`, `llmPriceOutputPerMillion`.
- `.env.example` — documents `JANTRA_PROVIDER`, `JANTRA_BASE_URL`, `JANTRA_API_KEY`, `JANTRA_MODEL`, `JANTRA_MODEL_PRO`, `JANTRA_PRICE_INPUT`, `JANTRA_PRICE_OUTPUT`.

**How to activate:** set `JANTRA_PROVIDER=openai-compatible` + `JANTRA_BASE_URL=https://openrouter.ai/api/v1` + `JANTRA_API_KEY=sk-or-...` + `JANTRA_MODEL=anthropic/claude-sonnet-4`. Keep `GEMINI_API_KEY` set for the hybrid grounded-research fallback.

### Layer 2 — Per-run model switcher (in-app catalog)

**Files changed / new:**
- `src/model/catalog.ts` *(new)* — `MODEL_CATALOG` with 8 entries (Gemini Flash/Pro, Claude Sonnet/Opus 4, GPT-4.1, DeepSeek V3, Llama 3.3 70B, Perplexity Sonar). `resolveCatalog(id)` and `isCatalogModelAvailable(model)`.
- `src/model/index.ts` — `createProviderForStage(stage, choice, agentId, runModelId?)` — when `runModelId` is set and resolves in the catalog, that model is used for every stage.
- `src/server/routes/models.ts` *(new)* — `GET /v1/models` → returns catalog for the UI.
- `src/server/app.ts` — registers `registerModelRoutes(app)`.
- `src/server/schemas.ts` — optional `modelId` on `createRunBodySchema`, validated against catalog (invalid → 400).
- `src/pipeline/types.ts` — `Project.modelId?: string`.
- `src/pipeline/orchestrator.ts` — `CreateProjectOptions.modelId`; persisted; threaded into `createProviderForStage`.
- `src/server/routes/runs.ts` — forwards `body.modelId` to `createProject`, records in audit.
- `src/pipeline/research/citationVerifier.ts` — skeptic provider also passes `ctx.project.modelId`.
- `web/src/api/client.ts` — `ModelOption` type, `listModels()`, `modelId?` on `createRun` + `RunDetail`.
- `web/src/routes/AgentCatalog.tsx` — `<select>` picker per agent tile (default = server env model, otherwise catalog pick).
- `web/src/styles.css` — `select` added to input/font-inherit rule; `.start-row select` sized reasonably.
- `src/server/smoke.ts` — extended to cover `/v1/models`, `modelId` persistence, invalid-id rejection.

**All workspace typechecks, server smoke, and mock pipeline smoke pass.**

## Verified test coverage

- `npm run typecheck` — root + web + desktop + client + embed-widget workspaces: ✓ clean
- `npm run server:smoke` — auth, host/origin guards, agent catalog, model catalog, runs (with modelId), audit: ✓ pass
- `npm run smoke` — mock pipeline (Intake → Research → Planning artifacts, verified claims, Build disabled): ✓ pass

## What's next (not yet planned/started)

- **Commit the work tree** — neither Layer 1 nor Layer 2 is committed. All changes are unstaged.
- **Per-stage model override** — the factory already takes a `stage` arg; a future per-stage picker is reachable by passing different catalog ids per stage. Not needed now.
- **Key-availability guard at run creation** — currently a run created with an OpenRouter modelId but no `JANTRA_API_KEY` fails at `advance` time, not at `POST /v1/runs`. Could add a server-side available check in the schema refine to fail fast.
- **Global setting (Settings page)** — a single preferred-model default in the Settings route, simpler than per-run if that's all that's needed.

**Why:** [[multi-llm-provider-plan]]

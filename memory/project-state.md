---
name: project-state
description: Current implementation state of Jantra — what is built, what is uncommitted, and what is next
metadata:
  type: project
---

## What is Jantra

Jantra is an AI-pipeline backend (TypeScript / Fastify) that orchestrates multi-stage LLM research and planning runs. It has a React web UI, a desktop wrapper, a CLI, and a remote-deploy mode (Railway / Cloudflare edge).

Core runtime path: `POST /v1/runs` → `createProject` (orchestrator) → `advanceStage` → `StageRunner` (per-stage handler) → `ModelProvider.generate` → artifacts saved to project store → server-sent events to UI.

## Completed Features & Recent Milestones

All features below are committed to `main`.

### Layer 1 — OpenAI-compatible provider (Shipped 2026-06-10)
- `src/model/openaiCompatible.ts` — `OpenAICompatibleProvider` supporting generic `/chat/completions` endpoints (OpenRouter, OpenAI, DeepSeek, Groq, Ollama, etc.). Handles message mapping, tool calls, JSON-schema responses, reasoning, and hybrid Google Search grounding via Gemini.
- Configuration options: `JANTRA_PROVIDER`, `JANTRA_BASE_URL`, `JANTRA_API_KEY`, etc.

### Layer 2 — Per-run model switcher (Shipped 2026-06-10)
- `src/model/catalog.ts` — Server-controlled `MODEL_CATALOG` returned via `GET /v1/models`.
- Added model selection dropdown per agent in UI, validated against catalog on run creation.

### Security & Reliability Fixes (Shipped 2026-07-15)
- **Fix 1 (High):** Bounded Fastify `trustProxy` to trust exactly `1` hop in remote mode, preventing `X-Forwarded-For` rate-limiting bypass.
- **Fix 2 (High):** Implemented `assertPublicWebhookUrl` ([urlGuard.ts](src/server/webhooks/urlGuard.ts)) checking schemes, private IPs, and resolving host DNS to prevent blind SSRF in webhook delivery and subscription.
- **Fix 3 (Medium):** Added a parallel `behavioral-eval` job to the CI workflow ([ci.yml](.github/workflows/ci.yml)) to run evaluation and smoke suites on every branch push or pull request.
- **Fix 4 (Medium):** Introduced a generic `fetchWithTimeout` utility and wired it to page fetches, webhooks, Stripe/Shopify connectors, and Gemini model calls.
- **Fix 5 (Medium):** Implemented daily spending ceiling enforce checks (default $2.00) for the completion gateway, backed by `gateway-spend.json` and SQLite table `client_daily_gateway_spend`.
- **Fix 6 (Medium):** Confined the CSV ops connector directory to resolve relative to the client's data root `data/ops/<clientId>` and prevent directory traversal.

## Verified test coverage

- `npm run typecheck` — workspaces root + web + desktop + client + embed-widget: ✓ clean
- `npm run eval` — guardrails, regressions, policy checks: ✓ **45/45 checks pass** (including new rate limit, webhook URL guard, completion gateway budget, and CSV path resolve regressions)
- `npm run smoke` — pipeline mock run produces artifacts and verified claims: ✓ pass
- `npm run server:smoke` — auth, host checks, runs creation, complete gateway, catalog: ✓ pass

## What's next

- **Per-stage model override** — support configuring catalog ids per individual pipeline stage instead of per run.
- **Key-availability validation at run creation** — validate keys/settings before starting the run instead of failing during the run.
- **Global Settings interface** — allow users to configure default preferred models globally in the UI.

**Why:** [[multi-llm-provider-plan]]

---
name: multi-llm-provider-plan
description: How Jantra became LLM-provider-agnostic — Layer 1 (OpenRouter adapter) and Layer 2 (per-run UI model switcher) both shipped 2026-06-10
metadata:
  type: project
---

Both layers are implemented (uncommitted as of 2026-06-10). Full spec: `docs/MULTI_LLM_PROVIDER_PLAN.md`.

## Key decisions (locked)

- **Provider interface** — everything talks to `ModelProvider` (`src/model/provider.ts`). Adding an LLM = one new class + one factory branch in `createProviderForStage` (`src/model/index.ts`). Zero pipeline changes.
- **OpenAI-compatible adapter** — one class (`src/model/openaiCompatible.ts`) covers OpenRouter, OpenAI, DeepSeek, Groq, Together, vLLM/Ollama by base URL alone.
- **Default route** — OpenRouter (`https://openrouter.ai/api/v1`). One key, hundreds of models.
- **Hybrid grounding** — grounded research calls (Google Search) are Gemini-only; the `OpenAICompatibleProvider` auto-delegates `grounding:true` requests to an internal `GeminiProvider`. Both keys must be set.
- **Catalog** — server-side `MODEL_CATALOG` in `src/model/catalog.ts` is the single source of truth for selectable models. UI fetches `GET /v1/models` and renders buttons; server controls which models are allowed.

## Layer 1 — OpenAI-compatible provider (DONE)

Set `.env`:
```
JANTRA_PROVIDER=openai-compatible
JANTRA_BASE_URL=https://openrouter.ai/api/v1
JANTRA_API_KEY=sk-or-...
JANTRA_MODEL=anthropic/claude-sonnet-4        # flash-tier
JANTRA_MODEL_PRO=anthropic/claude-opus-4      # pro-tier
GEMINI_API_KEY=...                            # still needed for hybrid research
```

## Layer 2 — Per-run model switcher (DONE)

`POST /v1/runs` accepts optional `modelId` (catalog id, e.g. `"claude-sonnet-4"`). Validated against the catalog (unknown id → 400). Persisted on `Project.modelId`. Every stage provider is built from that catalog entry via the 4th arg of `createProviderForStage`. Grounded stages still force Gemini inside the provider — no stage-level flag needed.

UI: `<select>` in `AgentCatalog.tsx`, populated from `GET /v1/models`. Unavailable models (missing keys) shown disabled.

**Why:** user wants to swap models experiment-by-experiment without touching env vars. [[project-state]]

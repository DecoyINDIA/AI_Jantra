# Multi-LLM Provider Plan

Status: **Layer 1 implemented · Layer 2 implemented** · Last updated: 2026-06-10

Goal: stop being locked to Gemini. Be able to run any LLM (Claude, GPT, Llama,
DeepSeek, Perplexity Sonar, etc.) **without changing pipeline/agent code** — first
via environment variables, and later via in-app model-switch buttons.

The codebase is already built for this: everything talks to the provider-agnostic
`ModelProvider` interface (`src/model/provider.ts`). `GeminiProvider` and
`MockProvider` are just two implementations, selected by the factory
`createProviderForStage` (`src/model/index.ts`). Adding an LLM = one new class +
one factory branch. No pipeline changes.

---

## Decisions locked

| Topic | Decision |
| --- | --- |
| Adapter strategy | One `OpenAICompatibleProvider` (OpenAI `/chat/completions` shape). Covers OpenRouter, OpenAI, DeepSeek, Groq, Together, vLLM/Ollama by base URL alone. |
| Default route | **OpenRouter** (`https://openrouter.ai/api/v1`) — one key, hundreds of models, switch model via a single string. |
| Grounding (web search) | **Hybrid** — keep `GeminiProvider` for grounded research calls (Google Search is Gemini-only); route everything else through OpenRouter. Requires both `GEMINI_API_KEY` and the OpenRouter key set. |
| Explicit caching | Skipped for the OpenAI-compatible provider (OpenRouter/DeepSeek auto-cache server-side). Gemini keeps its explicit cache logic. |
| Cost tracking | Read OpenRouter's returned `usage.cost` when present; fall back to env-configured per-million rates otherwise. |
| UI switcher granularity | **Per-run** when built (matches a chatbot's model dropdown). Future good-to-have. |

### Pricing note (OpenRouter vs direct)
Per-token inference price on OpenRouter is usually the **same** as the upstream
provider; OpenRouter's margin is a ~5% credit top-up fee (and ~5% surcharge on
BYOK). So direct is marginally cheaper, but OpenRouter buys model flexibility and
sometimes routes to cheaper third-party hosts. Verify live prices before
committing — they change often.

### Capability caveat (per model, not code)
The pipeline leans on **tool-calling** and **structured JSON output**. Claude,
GPT, Gemini, Llama-3.3, Qwen, DeepSeek support these well. **Perplexity Sonar** is
search-tuned with weak/no tool-calling — fine as a research model, weak as the
planning/agent model. The adapter works regardless, but model choice matters for
the agent/planning stages.

---

## Layer 1 — Provider adapter (IMPLEMENTED)

Shipped: `src/model/openaiCompatible.ts` (`OpenAICompatibleProvider`), wired in
`src/model/index.ts`, config in `src/config.ts`, types loosened in
`src/model/provider.ts`, env documented in `.env.example`. Grounded calls
delegate to an internal `GeminiProvider` automatically. Verified with stubbed
`fetch` (message mapping, tool calls, JSON-schema, cost-from-API, cost fallback,
reasoning capture) and the mock-mode smoke test still passes.

Switching providers becomes pure `.env`:

```
JANTRA_PROVIDER=openai-compatible
JANTRA_BASE_URL=https://openrouter.ai/api/v1
JANTRA_API_KEY=sk-or-...
JANTRA_MODEL=anthropic/claude-sonnet-4        # flash-tier slot
JANTRA_MODEL_PRO=anthropic/claude-opus-4      # pro-tier slot
GEMINI_API_KEY=...                            # still needed for hybrid research
```

### Files

1. **`src/model/provider.ts`** — loosen two types (mechanical; only read as strings downstream):
   - `ModelResult.provider`: `"gemini" | "mock"` → add `"openai-compatible"`.
   - `ModelResult.modelId` and `ModelProvider.id`: `GeminiModelId` → `string`.

2. **`src/config.ts`**
   - `providerFromEnv()` accepts `"openai-compatible"`.
   - New fields: `baseUrl` (`JANTRA_BASE_URL`), `llmApiKey` (`JANTRA_API_KEY`).
   - `getModelIdForStage` returns the env model strings (`JANTRA_MODEL` /
     `JANTRA_MODEL_PRO`) for the OpenAI path instead of hardcoded `gemini-2.5-*`.
   - `requireApiKey()` checks the active provider's key.

3. **`src/model/openaiCompatible.ts`** *(new — the core work, ~150 lines)*.
   Implements `ModelProvider`. Uses `fetch` (already polyfilled; no new SDK).
   Reuses the 3-attempt retry loop pattern from `gemini.ts`. Mapping:

   | Internal | OpenAI chat |
   | --- | --- |
   | `system` | first `{role:"system"}` message |
   | role `model` / `user` | `assistant` / `user` |
   | `functionCall` part | assistant `tool_calls[]` |
   | `functionResponse` part | `{role:"tool", tool_call_id, content}` |
   | `ToolSpec` | `tools:[{type:"function", function:{name,description,parameters:inputSchema}}]` |
   | `toolChoice` | `tool_choice: auto/required/none` |
   | `responseJsonSchema` | `response_format:{type:"json_schema", ...}` |
   | `thinking` | read back `choices[].message.reasoning` → `result.thinking` |

   - Cost: send `usage:{include:true}` to OpenRouter, read `usage.cost`; env
     fallback (`JANTRA_PRICE_INPUT` / `JANTRA_PRICE_OUTPUT`) otherwise.
   - Caching: returns `cache.status:"skipped"` (no explicit cache logic).
   - The Gemini-only guard "no structured output + tools together"
     (`gemini.ts:assertSupportedCombination`) can be relaxed here, but verify the
     chosen model actually supports `json_schema` (some only support
     `json_object`).

4. **`src/model/index.ts`** — one branch in `createProviderForStage`:
   ```ts
   if (config.provider === "openai-compatible") {
     return new OpenAICompatibleProvider(modelId, config.baseUrl, config.llmApiKey);
   }
   ```
   **Hybrid rule:** if the stage requires grounding, return `GeminiProvider`
   regardless of the configured provider.

5. **`.env.example`** — document the new vars above.

### Effort
~150-line new file + ~20 lines across 4 files. No pipeline/agent code touched.

---

## Layer 2 — In-app model switcher (IMPLEMENTED)

Shipped 2026-06-10: a server-side catalog (`src/model/catalog.ts`), `GET /v1/models`
(`src/server/routes/models.ts`, registered in `src/server/app.ts`), an optional
`modelId` on `POST /v1/runs` validated against the catalog
(`src/server/schemas.ts`), persisted on `Project.modelId` and threaded into
`createProviderForStage(stage, choice, agentId, runModelId)`. The run-create UI
gained a model `<select>` (`web/src/routes/AgentCatalog.tsx`, `listModels()` in
`web/src/api/client.ts`). Grounded research stays on Gemini automatically via the
provider's existing hybrid delegation, so no stage-level grounding flag was added.
Verified by the server smoke test (`/v1/models`, modelId persistence, invalid-id
rejection) and the mock pipeline smoke; all workspace typechecks pass.

Original design notes follow. Buttons let a user pick the model **per run**. Data flow:

```
[Buttons in UI]  →  modelId on POST /v1/runs  →  saved on the run/project
       ↑                                                    │
   GET /v1/models  (server catalog)                         ▼
   so buttons aren't hardcoded     advanceStage → createProviderForStage(stage, …, run.modelId)
                                                            │
                                   grounded research stage → forced Gemini (hybrid)
                                   everything else → the model the user picked
```

Design choice: a **server-side model catalog**, not a free-text box —
the UI renders buttons dynamically, and the server controls which models (and
therefore which keys/costs) are allowed.

### Files

| # | File | Change |
| --- | --- | --- |
| 1 | `src/model/catalog.ts` *(new)* | The list of selectable models + `resolveCatalog(id)`. Single source of truth. Entry: `{ id, label, provider, model, tier, supportsTools }`. |
| 2 | `src/server/routes/models.ts` *(new)* | `GET /v1/models` → returns catalog (label, id, tier) for the UI. |
| 3 | `src/server/schemas.ts` | Add optional `modelId` to `createRunBodySchema`, validated against the catalog. |
| 4 | `src/pipeline/orchestrator.ts` | `createProject` accepts + persists `modelId`; pass it into `createProviderForStage` (line ~171). |
| 5 | `src/model/index.ts` | `createProviderForStage` takes an optional catalog model; hybrid guard forces Gemini for grounded stages. |
| 6 | `src/types.ts` (Project type) | Add `modelId?: string` to the persisted project. |
| 7 | `web/src/api/client.ts` | Add `listModels()`; add `modelId` to `createRun` body. |
| 8 | `web/src/routes/*` (run-create form) | The buttons/dropdown — fetch `listModels()`, let user pick, send `modelId`. |

### Alternatives considered
- **Global setting** (one default in Settings) — simpler, not per-conversation.
- **Per-stage** (different model per intake/research/planning) — most flexible,
  most UI. The factory already takes a `stage` arg, so this is reachable later.

---

## Key call sites (for whoever implements)
- Provider factory: `src/model/index.ts` → `createProviderForStage`.
- Provider interface: `src/model/provider.ts` → `ModelProvider`, `ModelResult`.
- Gemini reference impl (mapping + cost + cache): `src/model/gemini.ts`.
- Pipeline provider instantiation: `src/pipeline/orchestrator.ts:171`.
- Run creation entry: `src/server/routes/runs.ts` → `POST /v1/runs`.
- Per-stage model resolution from env: `src/config.ts` → `resolveStageModel`.

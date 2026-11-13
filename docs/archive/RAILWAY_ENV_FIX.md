# Fix: Production still runs Gemini (429 quota errors in the widget)

**Date diagnosed:** 2026-06-11

> **STATUS UPDATE (2026-06-11, after variables were added):** the provider
> switch WORKED — live smoke test now reaches OpenRouter, Gemini errors are
> gone. ONE remaining problem: the `JANTRA_API_KEY` value pasted into Railway
> is **truncated** — it contains a literal `…` (ellipsis) character after
> `sk-or-v1-22a5fc`, i.e. the masked display preview was copied instead of
> the full key. Error seen: `Cannot convert argument to a ByteString …
> character at index 22 has a value of 8230`. Fix: copy the FULL key from
> the `JANTRA_API_KEY=` line in local `D:\XOLVER\Jantra\.env` (it is ~73
> chars long, no `…`) and re-paste it into the Railway variable, then let it
> redeploy. Also: `JANTRA_MODEL_INTAKE` is not a model-id variable in this
> codebase — if kept, its value must be literally `flash` or `pro`;
> otherwise delete it.

## Root cause

The live intake widget on xolver.in talks to the Railway service
`jantradesktop-production.up.railway.app`. That container gets its config
**only from Railway service variables** — the local `.env` in this repo is
never deployed (the `Dockerfile` copies only `src/` and `tsconfig.json`, and
`.env` is gitignored).

So editing `.env` here (OpenRouter key, DeepSeek model) changed nothing in
production. On Railway, `JANTRA_PROVIDER` is unset (or still `gemini`), and
`src/config.ts` defaults to `gemini` → every call runs on the free-tier
Gemini key → `429 RESOURCE_EXHAUSTED, model: gemini-2.5-flash`.

## The fix (5 minutes, Railway dashboard)

Open **railway.app → project → service `jantradesktop-production` →
Variables** and set:

| Variable | Value |
|---|---|
| `JANTRA_PROVIDER` | `openai-compatible` |
| `JANTRA_BASE_URL` | `https://openrouter.ai/api/v1` |
| `JANTRA_API_KEY` | the OpenRouter key (`sk-or-v1-…`) — copy from local `.env` |
| `JANTRA_MODEL` | `deepseek/deepseek-v4-flash` |
| `JANTRA_MODEL_PRO` | `deepseek/deepseek-v4-flash` |

Keep the existing `JANTRA_REMOTE_API_KEYS` (the intake-proxy worker's key
must keep matching) and any `JANTRA_SERVER_*` / dir vars as they are.

Railway redeploys automatically when variables change. If the service was
last deployed before commit `baf91c0` (multi-LLM provider support), also
trigger a redeploy from latest `main` of `DecoyINDIA/AI_Jantra`.

### Optional: `GEMINI_API_KEY`

Only **grounded research** (full planning pipeline) uses Gemini now; the
public website intake agent (`intake-public`) never does. Note that the
`GEMINI_API_KEY` currently in local `.env` is **invalid** — it's an
OAuth-style token (`AQ.…`); real Gemini API keys start with `AIza`. If you
ever run grounded research, generate a key at
<https://aistudio.google.com/apikey>. Leaving it unset only prints a startup
warning; it does not block the server.

## Verify after deploy

```powershell
# 1. Origin is up and authenticating (expect 401 with JSON error envelope):
curl.exe -s -i https://jantradesktop-production.up.railway.app/v1/agents -H "Authorization: Bearer probe"

# 2. End-to-end through the edge (expect 200/4xx JSON, NOT a Gemini error):
curl.exe -s -X POST "https://xolver.in/api/intake/v1/runs" -H "Origin: https://xolver.in" -H "Content-Type: application/json" -d "{\"agentId\":\"intake-public\",\"title\":\"smoke test\"}"

# 3. Then chat in the widget on xolver.in — errors mentioning
#    "gemini-2.5-flash" must be gone.
```

## What was already verified working (no action needed)

- OpenRouter key in `.env`: valid (live call returned 200, model replied,
  per-call `usage.cost` present → cost ceilings function).
- `deepseek/deepseek-v4-flash`: valid OpenRouter model id.
- Cloudflare worker `xolver-intake-proxy` (Website_Xolver
  `apps/intake-proxy/`): healthy, forwards to the Railway origin with the
  service key; allowlists only `POST /v1/runs`, `…/advance`,
  `…/interactions/:id`. (The widget's occasional flat `404
  {"error":"Not Found"}` comes from this allowlist — typically a retry
  against a run that no longer exists after the origin restarted, since the
  Railway container has no persistent volume for the SQLite store.)
- Repo `main` is pushed to GitHub including multi-provider support.

## Once-and-for-all rule

**Local `.env` = local runs only. Production model/provider changes are made
in Railway service variables.** If you want one source of truth, move the
values into Railway and treat `.env` as a dev sandbox.

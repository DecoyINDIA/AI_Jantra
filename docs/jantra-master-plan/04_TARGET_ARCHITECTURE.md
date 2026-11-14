# 04 — Target Architecture

> Historical target design. Current implementation and unresolved retention behavior are documented in [validation and follow-up](12_VALIDATION_AND_FOLLOW_UP.md); this document is not a completion record.

Principle: keep the single-process Node + SQLite shape; change it in small reversible steps. No rewrite is justified by the evidence.

## 1. Target picture

```
            Embeds (widget)            Operator UI (web)          Server-to-server (SDK)
                 │                           │                          │
        Cloudflare Worker edge               │                          │
   origin allowlist · route allowlist        │                          │
   per-IP limit · sets X-Jantra-Client-IP    │                          │
                 │  public-scope key         │  full-scope key          │  full-scope key
                 └───────────────┬───────────┴──────────────┬───────────┘
                                 ▼                          ▼
                       Fastify API (one process)
        auth → Identity{clientId, subject, scope} → scope guard → rate limit → routes
                                 │
          ┌──────────────────────┼─────────────────────────┐
          ▼                      ▼                         ▼
   Run service             Job runner (in-process)     Lead service
   create/confirm/reject   executes stages off the     capture · notify · link to run
   enqueue advance         request path, checkpoints
          │                      │
          ▼                      ▼
   Orchestrator ── StageRunner ── ModelProvider (Gemini | OpenAI-compatible | mock)
          │                      │
          ▼                      ▼
   SQLite (single file under JANTRA_DATA_DIR)      safeFetch (all outbound HTTP)
   projects · api_keys · spend · leads · webhooks · jobs · schema_migrations
   Files under JANTRA_DATA_DIR: artifacts/, sources/, audit/, ops/
```

## 2. Module boundaries

| Module | Owns | Must not |
|---|---|---|
| `src/server/**` | HTTP, auth, scope, validation, error envelope | Contain business rules about stages or cost |
| `src/pipeline/orchestrator.ts` | Stage state machine, gates, run lock | Know about HTTP or specific agents |
| `src/pipeline/stages/**`, `src/agents/**` | Agent behaviour | Read `process.env`; call `fetch` directly; touch the store except through `ctx.store` |
| `src/model/**` | Vendor SDKs, pricing | Be imported by stages except via `ModelProvider` |
| `src/pipeline/store/**` | All durable state | Leak SQL or file paths to callers |
| `src/util/safeFetch.ts` (new) | Every outbound request to a caller- or model-supplied URL | — |
| `src/config.ts` | Every environment variable | — (today six files read `process.env` directly; converge here) |

## 3. Data

### 3.1 One data root
```
JANTRA_DATA_DIR            default ".jantra"; production "/data/jantra"
  jantra.sqlite
  projects/<clientId>/<runId>/…        artifacts and source text (unchanged layout)
  audit/<runId>.jsonl
  leads/<clientId>/<leadId>.json       until T-015 moves leads into SQLite
  ops/<clientId>/…                     CSV drop folder
```
Resolution rule (T-003): an explicit `JANTRA_PROJECT_DIR`, `JANTRA_AUDIT_DIR`, `JANTRA_LEAD_DIR`, `JANTRA_OPS_DATA_DIR` wins; otherwise each derives from `JANTRA_DATA_DIR`. Existing deployments that set the old variables keep working.

### 3.2 SQLite schema additions (T-015; additive, each in a numbered migration)
```sql
create table schema_migrations (version integer primary key, applied_at text not null);

alter table api_keys add column scope text not null default 'full';        -- 'full' | 'public'
alter table api_keys add column allowed_agents text;                        -- JSON array or null

create table leads (
  id text primary key, client_id text not null, user_sub text,
  name text not null, email text not null, phone text, idea text not null,
  source text not null, run_id text, created_at text not null, deleted_at text
);
create index idx_leads_client_created on leads (client_id, created_at desc);

create table webhook_subscriptions (
  id text primary key, client_id text not null, url text not null,
  secret text, events text not null, created_at text not null
);

create table jobs (
  id text primary key, client_id text not null, run_id text not null,
  kind text not null,                -- 'advance' | 'confirm_continue' | 'interaction'
  payload text not null, status text not null,   -- queued | running | done | failed
  attempts integer not null default 0, error text,
  created_at text not null, started_at text, finished_at text
);
create index idx_jobs_status_created on jobs (status, created_at);

-- projects: add columns mirrored from the JSON blob so listing does not parse every row
alter table projects add column agent_id text;
alter table projects add column status text;
alter table projects add column current_stage text;
alter table projects add column cost_usd real;
```
The `data` JSON blob stays the source of truth for a run; mirrored columns are written in `saveProject`.

### 3.3 Budget reservation (T-012)
Replace check-then-spend with reserve-then-settle inside one SQLite transaction:
```
reserve(clientId, day, estimateUsd):  BEGIN IMMEDIATE;
   spend = select usd …; if spend + estimate > ceiling → ROLLBACK, return false
   upsert usd = usd + estimate; COMMIT; return true
settle(clientId, day, estimateUsd, actualUsd):  upsert usd = usd + (actual - estimate)
```
`estimateUsd` for the gateway is `gatewayRunCeilingUsd`; for intake it is the remaining per-run ceiling.

## 4. API contracts

### 4.1 Identity and scope (T-001)
```ts
export type KeyScope = "full" | "public";
export interface Identity {
  subject: string;
  clientId: string;
  mode: "local" | "remote";
  scope: KeyScope;              // local mode is always "full"
  allowedAgentIds?: string[];   // set only when scope === "public"
}
```
Public scope may call exactly:
`POST /v1/runs`, `GET /v1/runs/:runId`, `POST /v1/runs/:runId/advance`, `GET /v1/runs/:runId/interactions`, `POST /v1/runs/:runId/interactions/:interactionId`, `POST /v1/leads`, `GET /v1/leads`.
On `POST /v1/runs` a public key: `agentId` must be in `allowedAgentIds` (else 403 `agent_not_allowed`); `autonomy` other than `"gated"` → 403 `autonomy_not_allowed`; `modelId` present → 403 `model_pin_not_allowed`. Run-scoped routes also require the loaded run's `agentId` to be in the allowlist.

### 4.2 Error envelope (unchanged shape, T-007 tightens content)
```json
{ "error": { "code": "string", "message": "string", "details": {} } }
```
`internal_error` always carries the fixed message `"Internal error."` plus `details.requestId`; the real error goes to the server log with the same id.

### 4.3 Asynchronous execution (T-014)
```
POST /v1/runs/:runId/advance
  Header "Prefer: respond-async"  → 202 { run, job: { id, status: "queued" } }
  no header                        → today's blocking behaviour (kept for the widget and CLI)
GET  /v1/runs/:runId/jobs/:jobId   → { job }
GET  /v1/runs/:runId/events        → existing SSE; gains events job_started, job_finished, job_failed
```
One in-process worker loop claims `queued` jobs (`update … where id = ? and status = 'queued'`), runs them under the existing run lock, and on start-up marks `running` jobs older than the process as `queued` again. This removes proxy-timeout failures without adding a queue service.

### 4.4 Trusted visitor address (T-006)
The edge sets `X-Jantra-Client-IP` from `CF-Connecting-IP` after deleting any inbound copy. The origin reads it only when `identity.scope === "public"`; otherwise it is ignored. Rate-limit key: `"<keyId or subject>|<visitorIp or request.ip>"`. Per-visitor intake sub-budget: `JANTRA_INTAKE_VISITOR_DAILY_CEILING_USD` (default 0.10), stored in the existing spend table under client id `"<clientId>#<sha256(ip)[0:16]>"`.

### 4.5 Lead ↔ run link (T-020, T-021)
`POST /v1/leads` accepts optional `runId` (validated with `runParamsSchema`, must belong to the caller's tenant). New full-scope route `POST /v1/runs/:runId/promote` creates a `planning-pipeline` run whose intake stage is pre-confirmed with the source run's `idea_summary`, and returns the new run. On intake completion and on lead creation a `lead.created` / `run.intake_completed` webhook event is emitted through the existing dispatcher.

## 5. Security architecture

| Layer | Control |
|---|---|
| Edge | Origin allowlist, route allowlist, body cap, per-IP limit, strips client-supplied `X-Jantra-*` headers |
| Origin auth | API key → identity with scope; admin token only for `/v1/admin/*`; local mode loopback token + Host/Origin checks |
| Authorisation | Tenancy check on every run (existing) + scope guard (new) |
| Outbound | `safeFetch`: scheme check, `net.BlockList` for private/reserved ranges incl. IPv4-mapped IPv6, redirects followed manually (max 3) with re-validation, connect-time address re-check, response size cap |
| Cost | Reserve/settle budgets; fail closed when price is unknown; per-visitor sub-budget |
| Integrity | No synthetic data outside mock/explicit flag; delivery receipts state real status; research text re-verified after refinement |
| Secrets | Only `src/config.ts` reads env; per-client connector credentials encrypted at rest with a key from `JANTRA_SECRETS_KEY` (T-018) |
| Privacy | Lead deletion and retention job (T-023); audit redaction list extended to email/phone keys |

## 6. Frontend and UX

Keep React + Vite + React Query. Add, in order:
1. **Gate queue** as the home screen: runs in `awaiting_confirmation` or `awaiting_input`, oldest first, with cost and agent.
2. **Lead inbox**: leads with their linked intake summary and a "Promote to full plan" button.
3. **Client-ready export** of the three planning artifacts plus the research report with clickable source quotes (print stylesheet first; PDF later).
4. **First-run checklist**: provider key present, model reachable, data dir writable, edge reachable.
Widget: keep vanilla DOM; add an optional name/email step at the end that posts the lead with `runId`.

## 7. AI architecture

| Call type | Model tier | Extras |
|---|---|---|
| Public intake turns | Cheapest capable (flash tier) | Hard per-run and per-visitor ceilings |
| Research plan, section synthesis | Flash tier with search grounding | Deterministic citation check |
| Skeptic pass | Flash tier, batched: one call per section with all its claims, not one per claim | Fail closed on parse error |
| Report refine | Flash tier | Post-refine verification (T-011) |
| Planning | Pro tier; tournament only when the run is a paid/promoted plan (`project.autonomy` unchanged; new run option `quality: "standard" | "tournament"`, default standard) | Cross-document consistency check (existing) |
| Ops KPI maths, anomalies | No model | — |

No vector store or RAG is warranted: the corpus per run is a few dozen fetched pages already held as text.

## 8. Testing

Three tiers, all offline:
1. `node --test` unit tests for pure modules (T-017).
2. Existing eval/regression harness for behaviour that needs the mock provider.
3. `server:smoke` for HTTP contracts, extended with scope and error-envelope cases.
Live-model evals stay opt-in and outside CI.

## 9. Deployment

- One container, multi-stage build, compiled `dist/`, non-root, `npm ci --omit=dev` (T-016).
- One instance, one disk at `/data/jantra`; nightly `sqlite3 .backup` to object storage (operator runbook, not code).
- Edge Worker deployed from this repository so the allowlist and the origin's scope rules are versioned together.
- Config validated at start-up: refuse to start in remote mode if the data dir is not writable or no public/full key exists.

## 10. Migration path from today

| Step | Change | Reversible by |
|---|---|---|
| 1 | Scope on identity; public restrictions (T-001) | Set `JANTRA_PUBLIC_SUBJECTS=` (empty) |
| 2 | Data root + blueprint (T-003) | Old env vars still honoured |
| 3 | `safeFetch` adopted by webhooks and research (T-004) | Revert two call sites |
| 4 | Checkpoint saves, error envelope, store fixes (T-007, T-008, T-010) | Plain reverts |
| 5 | Edge header + keyed limits and budgets (T-005, T-006, T-012) | Header ignored if absent |
| 6 | SQLite migrations table; leads/webhooks/spend moved in with a one-time import (T-015) | Files left in place, read-only |
| 7 | Async jobs behind the `Prefer` header (T-014) | Header optional |
| 8 | Funnel features (T-020, T-021) | Additive routes |

## 11. Operating model

- One owner reviews every Wave 0 change personally before deploy.
- Deploy order: origin first, then edge. Roll back in reverse.
- Weekly: check audit for `cost_ceiling_exceeded`, `guardrail_block`, failed webhook warnings; check disk usage; restore the latest backup to a scratch file and run `PRAGMA integrity_check`.
- Documentation of record: `AGENTS.md` (rules for coding agents), `README.md` (run it), `docs/ARCHITECTURE.md` (this target, once adopted), `docs/DECISIONS.md` (dated one-line decisions). Everything else in `docs/` moves to `docs/archive/`.

# 01 — Project Intelligence

Repository: `DecoyINDIA/AI_Jantra`, inspected at commit `8a84143` (main, 37 commits, 2026-06-02 → 2026-11-08). Three remote branches exist (`fix/audit-remediation`, `fix/audit-remediation-followup`, `claude/sql-injection-attacks-u00mul`); all are fully merged (0 commits ahead of main).

**How this was established:** every statement below comes from reading the source, docs and git history. Nothing was installed, built or executed, so runtime behaviour is inferred from code. Each item is labelled **[F]** fact (read in code), **[A]** assumption, **[H]** hypothesis to test, or **[U]** unknown.

## 1. What the project is

**[F]** Jantra AI is a TypeScript/Node agent runtime (`@jantra/runtime`, ~15k lines in `src/`) plus several agents built on it, exposed through a Fastify HTTP API, a React operator UI, an Electron desktop shell, an embeddable chat widget and a Cloudflare Worker edge proxy. It is built by Xolver (an Indian software studio, `xolver.in`) and is unlicensed/private (`"license": "UNLICENSED"`).

**[F]** The runtime's design promises, repeated in `AGENTS.md`, `README.md` and `docs/PRD.md`: every model call goes through one provider interface; generator and critic are separate passes; research claims must cite a retrieved source or be dropped; everything is written to an append-only audit log; stages fail closed; a human gate sits between stages.

## 2. The agents registered today (`src/agents/registry.ts`)

| Agent id | What it does | Real maturity |
|---|---|---|
| `planning-pipeline` | Intake → Research → Planning (PRD, TRD, build plan); `build` stage registered but disabled | **[F]** Most complete. Has rubrics, critic loops, citation verification with a skeptic pass, a three-variant planning tournament. |
| `intake-public` | The intake stage alone, for anonymous website visitors ("Manthan" persona) | **[F]** The only agent with evidence of production use: `RAILWAY_ENV_FIX.md` documents it live on xolver.in behind a Cloudflare proxy. |
| `ops-onboarding` | "Lekha": interview → KPI design → source binding | **[F]** Implemented; depends on per-client data that has no production storage path. |
| `ops-reporting` | "Lekha": ingest → analyze → compose → deliver | **[F]** Not usable end to end (see Audit A-02, A-03): it reads artifacts that only exist in an `ops-onboarding` run, silently substitutes synthetic data, and its "deliver" stage sends nothing. |
| `firebnb-concierge` | Hotel-search chat agent calling an external functions URL with a service token | **[A]** A client or sister project (FireBNB). Deployed to Railway per commits `c768ecf`, `fdb98c3`. |
| `support-agent` | Reference tool-loop agent over an in-memory fake order backend | **[F]** Demo only. |

## 3. End-to-end flow (verified by reading)

```
Browser widget (packages/embed-widget)
   │  POST /v1/runs, /advance, /interactions/:id     (no key in browser)
   ▼
Cloudflare Worker (deploy/cloudflare-worker/worker.js)
   │  Origin allowlist, 5-route allowlist, 15 req/min per IP, 16 KB body cap,
   │  injects "Authorization: Bearer <service key>", forwards body unchanged
   ▼
Fastify origin (src/server/remote.ts → app.ts)   Railway today, Render blueprint added 2026-11-08
   │  rate limit (120/min per request.ip) → API-key auth → Identity{clientId, subject}
   ▼
routes/runs.ts → orchestrator.createProject / advanceUntilGate (per-run in-process lock)
   ▼
StageRunner or ReentrantStageRunner (src/agents/runners.ts)
   ▼
ModelProvider.generate (Gemini SDK | OpenAI-compatible HTTP | mock)
   ▼
Project JSON blob in SQLite `projects` table + artifact .md files + audit JSONL + SSE events
```

**[F]** State model: one `Project` document per run holds stages, artifacts, sources, claims, pending interactions, per-stage execution state and a cost rollup (`src/pipeline/types.ts`). In remote mode it is one JSON blob per row in SQLite (`src/pipeline/store/sqlite.ts`); in local mode without an admin token it is one JSON file per run (`src/pipeline/store.ts`).

**[F]** Stage status machine: `pending → in_progress → (awaiting_input ⇄ in_progress) → awaiting_confirmation → confirmed | rejected`; a rejected stage reruns with the reviewer's reason. Gate rules are enforced server-side in `orchestrator.ts` (`advanceStage`, `confirmStage`, `rejectStage`).

## 4. Technical maturity

| Area | State |
|---|---|
| Runtime core, provider abstraction, cost tracking | **[F]** Solid and consistent. Three providers; per-run model pin against a server catalog. |
| HTTP API | **[F]** 20 routes, Zod validation on every input, typed error envelope, tenancy check on every run-scoped route. |
| Auth | **[F]** Local: per-launch loopback token + Host/Origin checks. Remote: API keys (env list or SHA-256-hashed DB records), separate admin token for key management. No per-key permissions. |
| Persistence | **[F]** Split across SQLite (projects, keys, two spend tables) and loose files (artifacts, sources, audit, leads, webhooks, ops CSVs). No migrations framework. |
| Tests | **[F]** No test framework. A custom eval harness (`npm run eval`, `npm run smoke`, `npm run server:smoke`) with 20 regression functions in one 989-line file; project notes claim 45/45 checks pass (**[U]** not re-run here). |
| CI | **[F]** GitHub Actions: typecheck (root, web, client, widget — not desktop), build, eval + smoke. |
| Deploy | **[F]** One Dockerfile running TypeScript through `tsx` at runtime; Railway config; Render blueprint with a 1 GB disk; Worker edge. |
| Observability | **[F]** Audit JSONL per run and `console.log`. No structured logs, metrics or alerting. |
| Desktop | **[F]** Electron shell with OS-keychain Gemini key, backup, diagnostics; "licensing" only checks a key's format. |

## 5. Implemented versus planned

**Implemented [F]:** runtime loop, policy gate, audit, handoff; multi-turn re-entrant stages; SQLite project store; multi-provider models; three-stage planning pipeline with verification; public intake widget + edge; API key console; lead capture with Logto user attribution; webhooks on gate events; SSRF guard, rate limiter, daily budgets; `/v1/complete` LLM gateway.

**Planned or stubbed [F]:** Build stage (disabled by design); ops forecasting stage (disabled); report delivery (fabricated receipt); QuickBooks connector (named in a default binding, no implementation); scheduling/triggers (PRD R8, absent); Slack approvals (PRD A1, absent); per-client credential vault (PRD C2, absent — Stripe/Shopify keys come from process-wide env vars); config-defined agents (PRD C1, absent — agents are code); real licence verification.

**Documented next steps [F]** (`memory/project-state.md`): per-stage model override, key-availability validation at run creation, global settings UI.

## 6. Dependencies and constraints

- **[F]** Node ≥ 20, ESM, TypeScript strict. Runtime deps: `fastify`, `better-sqlite3` (native build), `@google/genai`, `zod`, `jose`, `dotenv`. No ORM, no queue, no cache.
- **[F]** Single-process by design: the per-run lock, rate limiter, event bus and JSON read-modify-write stores are all in-memory or file-based. `render.yaml` pins `numInstances: 1`.
- **[F]** Grounded research always runs on Gemini (Google Search grounding) even when another provider is selected, so `GEMINI_API_KEY` is required for the planning pipeline.
- **[F]** Root `package.json` scripts call `npm.cmd`, which exists only on Windows; `npm run typecheck`, `web:dev`, `desktop:*`, `client:build`, `embed:build` fail on macOS/Linux. CI avoids them by calling `npx tsc` and `npm run … --workspace` directly.
- **[U]** The production edge proxy is described as `xolver-intake-proxy` living in a different repository (`Website_Xolver/apps/intake-proxy`). Whether it matches `deploy/cloudflare-worker/worker.js` in this repo cannot be checked from here.

## 7. Business model as it appears

- **[F]** `docs/PRD.md`: a done-for-you agent studio for SMB/mid-market back offices, sold as setup fee plus monthly retainer, with an "Operations agent" as the wedge and trust (audit, gates, handoff) as the moat. Price points are explicitly unvalidated.
- **[F]** What was actually built first is different: an idea-to-plan pipeline dogfooded on Xolver's own client intake, and a public widget that turns site visitors into leads.
- **[H]** The working business today is lead generation for Xolver's services, not a sold product. There is no billing, plan, quota-per-customer or sign-up code anywhere in the repository.

## 8. Competitive advantage, if any

- **[F]** Real and unusual: deterministic citation verification plus an adversarial skeptic pass (`src/pipeline/research/citationVerifier.ts`), a number-provenance check for ops reports (`verifyNumberProvenance`), a model-free KPI formula engine and anomaly engine, and a complete audit trail with cost per call.
- **[H]** None of this is yet a moat: it is not exposed to a buyer as a visible proof ("every figure in this report links to its source quote"), and the product that would benefit most (ops reporting) is the least finished.

## 9. Strongest realistic version

An intake-to-proposal engine for software and product agencies: a visitor describes an idea to the widget, the agency gets a qualified lead with a researched, cited brief and a draft PRD/TRD/build plan, reviews it at human gates, and sends a scoped proposal the same day. Xolver runs it first; other agencies get it white-labelled through the existing embed widget, API keys and per-`clientId` tenancy. The trust features become the selling point: every market claim in the brief is click-through verifiable. Document 03 argues why this beats continuing on three fronts.

## 10. Open unknowns that need the owner

1. ~~Is `firebnb-concierge` served to the public through the same service key as the Xolver intake widget?~~ Resolved 2026-11-12: public keys may start `intake-public` and `firebnb-concierge` (T-001 default).
2. Which host is production today — Railway or Render — and does it have a persistent volume? (`RAILWAY_ENV_FIX.md` says the Railway container had none.)
3. Where do leads currently land in production, and has anyone read them? (See Audit A-04: on the Render blueprint they are written to ephemeral disk.)
4. Does the deployed edge proxy forward the request body unmodified, as the in-repo Worker does?
5. Is there any paying or committed external customer for either the planning pipeline or Lekha?

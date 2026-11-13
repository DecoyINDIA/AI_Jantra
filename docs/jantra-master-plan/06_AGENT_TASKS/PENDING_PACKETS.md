# Pending packets (T-014 to T-026)

These are scoped and bounded, but **not yet safe to hand to a small agent**. Each names the discovery still needed. Before execution, a strong model should spend one short pass turning the outline into a full packet in the same format as T-001 to T-013. Contracts referenced here are defined in `04_TARGET_ARCHITECTURE.md`.

---

## T-014 — Asynchronous stage execution (P2, Advanced, L)
- **Objective:** `POST /v1/runs/:id/advance`, `/confirm` and the interaction POST return `202` with a job when the caller sends `Prefer: respond-async`; an in-process worker runs the stage; SSE reports job events. Without the header, behaviour is unchanged.
- **Prereqs:** T-010. Do after T-015 if both are scheduled, so `jobs` is a real table; otherwise keep jobs in the project blob.
- **Files expected:** `src/server/routes/runs.ts`, `src/server/routes/interactions.ts`, new `src/server/jobs/{queue,worker}.ts`, `src/pipeline/store/sqlite.ts`, `src/audit.ts` (new event types), `web/src/api/client.ts`, `web/src/routes/RunDetail.tsx`.
- **Contract:** architecture §4.3.
- **Acceptance:** a stage that takes longer than any HTTP timeout completes; killing the process mid-job and restarting re-queues and finishes it exactly once per stage (gate rules already prevent duplicates); the widget (no header) is unaffected.
- **Discovery needed:** how `web/src/routes/RunDetail.tsx` currently awaits `/advance`; whether the JSON store must support jobs (recommend: async mode only with SQLite; return 400 `async_not_supported` otherwise).
- **Escalate if:** the run lock cannot be shared between request path and worker without a deadlock.

## T-015 — One SQLite database with migrations (P2, Advanced, L)
- **Objective:** leads, webhook subscriptions and spend live in SQLite; a `schema_migrations` table applies numbered migrations at start; `projects` gains mirrored columns so listing does not parse every blob; `api_keys` gains `scope` and `allowed_agents`.
- **Prereqs:** T-003, T-008.
- **Files expected:** `src/pipeline/store/sqlite.ts`, new `src/pipeline/store/migrations/*.ts`, `src/server/leads/store.ts`, `src/server/webhooks/store.ts`, `src/server/app.ts`, `src/server/routes/adminKeys.ts`, `src/server/scope.ts`.
- **Contract:** architecture §3.2. One-time import: on first start after the migration, read existing lead and webhook JSON files into the tables and rename the folders with a `.imported` suffix (never delete).
- **Acceptance:** fresh database and upgraded database produce identical schemas; listing 1,000 runs issues one query and parses no blobs; import is idempotent.
- **Discovery needed:** whether desktop's database path (`desktopDatabasePath()`) needs the same import; whether local JSON mode should remain (recommend: keep for CLI only).
- **Escalate if:** any migration is not additive.

## T-016 — Production container (P2, Small, S)
- **Objective:** multi-stage Dockerfile: build stage `npm ci` + `npx tsc -p tsconfig.json`; runtime stage `node:20-slim`, `npm ci --omit=dev --workspaces=false`, copies `dist/`, runs as user `node`, `CMD ["node","dist/server/remote.js"]`, `HEALTHCHECK` on `/health`.
- **Prereqs:** T-009.
- **Discovery needed (10 minutes):** confirm `node dist/server/remote.js` starts under the mock provider (CI builds `dist` but nothing runs it; `tsconfig` uses `moduleResolution: "Bundler"`, so check that every relative import carries `.js` and that JSON/fixture paths such as `src/runtime/evals/fixtures/transcript.json` are not required at runtime). The data directory must be writable by `node` (Render disk mount ownership).
- **Acceptance:** image builds; container starts with `JANTRA_PROVIDER=mock` and answers `/health`; `tsx` and `typescript` are absent from the runtime image.
- **Escalate if:** better-sqlite3 needs build tools in the runtime stage (then copy `node_modules` from the build stage after `npm prune --omit=dev`).

## T-017 — Unit tests with `node:test`; split regressions (P2, Medium, M)
- **Objective:** `npm test` runs `node --import tsx --test "src/**/*.test.ts"`; first suites for `formulaEngine`, `anomalyEngine`, `citationVerifier` (deterministic part), `netGuard`, `parseCsv`, `reportProvenance`, `rateLimit`. Split `src/runtime/evals/regressions.ts` into `regressions/{policy,agent,budget,server,security,ops}.ts` with an index that preserves ids and order. Add `npm test` to CI.
- **Prereqs:** T-009; easier after T-004 and T-011.
- **Acceptance:** eval report lists the same regression ids as before the split; `npm test` exits 0; no new dependency.
- **Discovery needed:** none beyond reading the files.

## T-018 — Per-client connector credentials (P2, Advanced, L) — approved (D-3 = Yes, 2026-11-13)
- **Objective:** Stripe/Shopify credentials stored per `clientId`, encrypted at rest (AES-256-GCM, key from `JANTRA_SECRETS_KEY`), written through a full-scope admin route, read only by connectors via `StageContext`; `process.env` fallbacks removed from `opsReporting.ts` and both connectors.
- **Prereqs:** T-015. A design partner is confirmed; before building, produce one report by hand from the partner's real export (experiment X5) so the connector and field-mapping requirements come from real data.
- **Open design question to settle in the full packet:** how an `ops-reporting` run finds its tenant's onboarding output (recommended: a per-client `ops_profiles` table written when an `ops-onboarding` run completes, read by reporting; removes the cross-project artifact lookup described in Audit A-03).

## T-019 — Real report delivery (P2, Medium, M) — approved (D-3 = Yes, 2026-11-13)
- **Objective:** `runOpsDeliver` sends through one configured channel (email via an HTTP provider API, or webhook) and records the provider's message id; receipt `status` becomes `sent` or `failed`; recipients come only from stored, operator-confirmed settings.
- **Prereqs:** T-002, T-018. **Discovery:** choose provider with the owner.

## T-020 — Promote intake to plan; gate queue UI (P2, Advanced, L)
- **Objective:** `POST /v1/runs/:runId/promote` (full scope) creates a `planning-pipeline` run whose intake stage is already `confirmed` with a copy of the source run's `idea_summary`; web home screen becomes a queue of runs awaiting a human, plus a lead inbox with a Promote button.
- **Prereqs:** T-021.
- **Contract:** architecture §4.5.
- **Discovery needed:** how `runResearch` reads the idea (`latestIdeaSummary(ctx)`) and intake "anchors", to confirm a copied artifact is sufficient; current structure of `web/src/routes/RunList.tsx` and `App.tsx` routing.
- **Acceptance:** promoting a completed `intake-public` run yields a run sitting at `research: pending` that completes under the mock provider; source run is unchanged; audit records `run_created` with `promotedFrom`.

## T-021 — Lead notification and lead↔run link (P2, Medium, M)
- **Objective:** `POST /v1/leads` accepts optional `runId` (must exist in the caller's tenant); two new webhook event types, `lead.created` and `run.intake_completed`, go through the existing dispatcher; the widget's completion step can collect name and email and post the lead with the run id.
- **Prereqs:** T-001, T-003.
- **Files expected:** `src/server/schemas.ts`, `src/server/routes/leads.ts`, `src/server/leads/store.ts`, `src/server/routes/webhooks.ts` (event enum), `src/runtime/gateEvents.ts`, `src/server/webhooks/dispatcher.ts`, `packages/embed-widget/src/index.ts`, `deploy/cloudflare-worker/worker.js` (allow `POST /v1/leads`).
- **Discovery needed:** the production proxy for leads lives in another repository; confirm with the owner whether this repo's Worker should carry the leads route. Read `src/runtime/gateEvents.ts` for the event shape.
- **Acceptance:** creating a lead with a webhook subscribed delivers one signed event containing lead id and run id, and no personal fields beyond what the owner approves (default: ids only).

## T-022 — Client-ready export (P2, Medium, M) — light validation
- **Objective:** a print-styled HTML view of a run's research report, PRD, TRD and build plan, where each cited claim expands to its source title, URL and verified quote; browser "Save as PDF" is the first export path.
- **Prereqs:** T-020. **Validation:** show a sample to three prospects before investing in a PDF pipeline.

## T-023 — Lead retention and deletion (P2, Medium, M) — period decided: 30 days (D-6, 2026-11-13)
- **Objective:** `DELETE /v1/leads/:id` (full scope, or the lead's own verified user); start-up and daily sweep removing leads older than `JANTRA_LEAD_RETENTION_DAYS` (default 30); deletion audited with ids only.
- **Prereqs:** T-015, and **T-021 deployed first**: with a 30-day window, leads must already be notified to a person and pushed to a durable system of record before the sweep exists, or they will be deleted unread.
- **To settle in the full packet:** whether the linked intake run (which contains the visitor's idea text) and its audit file are deleted with the lead or kept anonymised.

## T-024 — Operator UI token handling (P3, Small, S)
- **Objective:** keep the API and admin tokens in memory or `sessionStorage` by default with an explicit "remember on this device" option; never render the admin token back into an input.
- **Files:** `web/src/api/client.ts`, `web/src/routes/Settings.tsx`.

## T-025 — Real desktop licence verification (P2, Medium–Large) — desktop is a product (D-5 = Yes, 2026-11-13)
- **Problem:** `desktop/src/licensing.ts` marks any string matching `/^JANTRA-[A-Z0-9-]{8,}$/` as an active licence and stores the result in an editable JSON file.
- **Objective:** licence keys are signed tokens (Ed25519; public key embedded in the app, private key held by the owner) carrying licensee, plan and expiry; `activateLicense` verifies the signature offline with `node:crypto`; `licenseStatus` re-verifies the stored token on every read instead of trusting `license.json`; the UI shows licensee, plan, expiry and an "unlicensed" state.
- **Needs a design pass first (strong model plus owner):** what an unlicensed app may do (block, trial period, or read-only); whether activation is offline-only or also checks a revocation list; how keys are issued (a small CLI script is enough to start); and whether the desktop app should support OpenAI-compatible providers, since today it stores and reads only a Gemini key (`desktop/src/secrets.ts`, `desktop/src/main.ts`).
- **Interim step, safe for a small agent now:** label the current status "unverified" in the UI so nothing is sold on the stub.
- **Also follows from D-5:** the desktop typecheck in T-009 must be a blocking CI step; if it surfaces real type errors, fixing them is a separate small task.

## T-026 — Model catalog from configuration (P3, Small, S)
- **Objective:** `MODEL_CATALOG` loads from an optional JSON file (`JANTRA_MODEL_CATALOG_PATH`) validated with Zod, falling back to the built-in list; start-up logs any catalog id that the configured endpoint does not list.
- **Note:** model ids in `src/model/catalog.ts` could not be verified from the repository; check each against the provider's current model list before relying on it.

# Packets Status & Reconciliation (T-014 to T-026)

This document tracks the execution status of task packets T-014 through T-026, reconciling code implementation with production deployment and acceptance records.

> **Status Distinction:**
> - **Implemented (Code Complete & Offline Verified):** The code is fully written, merged in git, and passes typecheck, unit tests (`npm test`), regressions, and smoke tests.
> - **Deployed & Accepted:** The service is running in production (Render persistent disk origin + Cloudflare Worker edge) and has passed the 8 live acceptance verification checks in `PROGRESS.md`.
> - **Blocked:** Awaiting external inputs (e.g. partner data or owner design decisions).

---

## Task Packet Summary

| Packet | Priority | Status | Commit | Offline Verification | Deployment / Acceptance State |
|---|---|---|---|---|---|
| **T-014** | P2 | Implemented (Production acceptance pending) | `d685952` | Unit tests + eval regression (95 unit, 70/70 eval) | Pending Live Acceptance #8 (async stage execution & crash recovery) |
| **T-015** | P2 | Implemented (Production acceptance pending) | `23f80e1` | 5 unit tests + eval regression (95 unit, 70/70 eval) | Pending Render persistent volume migration & cutover |
| **T-016** | P2 | Implemented (Production acceptance pending) | `3239b8a` | Docker build + container /health smoke | Pending Render production build & deployment |
| **T-017** | P2 | Implemented (Pushed) | `f57df4d` | `node:test` runner + split regressions (95 unit, 70/70 eval) | Active in CI (`npm test`, 95 tests green, 70/70 eval) |
| **T-018** | P2 | Externally Blocked (Framework Implemented) | `a6a1271` | Unit tests + eval regression (95 unit, 70/70 eval) | **Blocked**: Framework implemented; acceptance blocked by X5 and live delivery |
| **T-019** | P2 | Externally Blocked (Framework Implemented) | `12c2a63` | Unit tests + eval regression (95 unit, 70/70 eval) | **Blocked**: Framework implemented; acceptance blocked by X5 and live delivery |
| **T-020** | P2 | Implemented (Production acceptance pending) | `7992930` | Unit tests + eval regression (95 unit, 70/70 eval) | Pending Live Acceptance #6 (production promote route verification) |
| **T-021** | P2 | Implemented (Production acceptance pending) | `258c149` | 3 unit tests + eval regression (95 unit, 70/70 eval) | Pending Live Acceptance #5 (signed webhook delivery to CRM/Slack) |
| **T-022** | P2 | Implemented (Production acceptance pending) | `21c4e81` | 6 unit tests + eval regression (95 unit, 70/70 eval) | Pending Live Acceptance #7 (client PDF export review by prospects) |
| **T-023** | P2 | Implemented (Production acceptance pending) | `c36d7b0` | 4 unit tests + eval regression (95 unit, 70/70 eval) | Implemented (sweep gated by `JANTRA_ENABLE_LEAD_DELETION_SWEEP=false` per D-6 until webhooks proven) |
| **T-024** | P3 | Implemented (Production acceptance pending) | `b32ce0d` | Workspace typecheck + UI verification | Pending operator acceptance on staging/production UI |
| **T-025** | P2 | Implemented (Pushed) | `b385290` | 12 unit tests + 2 eval regressions (95 unit, 70/70 eval) | Offline Ed25519 license verification, unlicensed read-only enforcement, pure issuance library, and multi-provider desktop config |
| **T-026** | P3 | Implemented (Pushed) | `fc7b3bf` | 7 unit tests + eval regression (95 unit, 70/70 eval) | Implemented; catalog loaded from `JANTRA_MODEL_CATALOG_PATH` with Zod schema and offline test isolation |

---

## Detailed Packet Records

### T-014 — Asynchronous stage execution (P2, Advanced, L)
- **Status:** Implemented (Code Complete)
- **Commit:** `d685952`
- **Implemented Code:**
  - `src/server/jobs/types.ts`: Job records, statuses (`queued`, `running`, `completed`, `failed`), and payloads.
  - `src/server/jobs/worker.ts`: In-process `JobWorker` with crash recovery re-queueing unfinished jobs upon startup.
  - `src/server/routes/runs.ts`: Routes return `202 Accepted` with a job record when the caller sends header `Prefer: respond-async`.
  - `src/pipeline/store/sqlite.ts`: Persistent `jobs` table storing background stage execution jobs.
  - Regression: `async-stage-execution` in `src/runtime/evals/regressions/server.ts`.
- **Deployment & Acceptance State:** Pending production deployment on Render and live verification of Live Acceptance Gate #8.

### T-015 — One SQLite database with migrations (P2, Advanced, L)
- **Status:** Implemented (Code Complete)
- **Commit:** `23f80e1`
- **Implemented Code:**
  - `src/pipeline/store/sqlite.ts`: Numbered SQL schema migrations (`schema_migrations`), mirrored columns on `projects` (`title`, `client_id`, `agent_id`, `status`, `current_stage`, `created_at`, `updated_at`), tables for `leads`, `webhook_subscriptions`, and `api_keys` with `scope` and `allowed_agents`.
  - Idempotent one-time import of legacy JSON leads and webhooks with `.imported` folder renaming.
  - Unit tests in `src/pipeline/store/sqlite.test.ts`.
- **Deployment & Acceptance State:** Pending Render deployment with persistent disk mount at `/data/jantra`.

### T-016 — Production container (P2, Small, S)
- **Status:** Implemented (Code Complete)
- **Commit:** `3239b8a`
- **Implemented Code:**
  - `Dockerfile`: Multi-stage Docker build (`build` stage compiling TypeScript; runtime stage `node:20-slim`, `better-sqlite3` native rebuild, non-root user `node`, `HEALTHCHECK` on `/health`).
  - `render.yaml`: Infrastructure definition specifying single instance, persistent disk, and healthcheck path.
- **Deployment & Acceptance State:** Pending deployment of image to Render production service `jantra`.

### T-017 — Unit tests with `node:test`; split regressions (P2, Medium, M)
- **Status:** Implemented (Code Complete)
- **Commit:** `f57df4d`
- **Implemented Code:**
  - Split regression suite into modules: `regressions/{common,policy,agent,budget,server,security,ops}.ts`.
  - Unit test suites using `node:test`: `formulaEngine`, `anomalyEngine`, `citationVerifier`, `netGuard`, `parseCsv`, `reportProvenance`, `rateLimit`.
  - `npm test` script wired in `package.json` and executed in CI pipeline.
- **Deployment & Acceptance State:** Fully accepted in CI; 61 unit tests and 64 regression checks green.

### T-018 — Per-client connector credentials (P2, Advanced, L)
- **Status:** Implemented (Infrastructure & Credential Storage Complete; Partner Field Mapping Gated on Experiment X5)
- **Implemented Code:**
  - `src/security/encryption.ts`: AES-256-GCM encryption/decryption with `JANTRA_SECRETS_KEY` and clean `DecryptionError` / `SecretsKeyMissingError` handling.
  - `src/pipeline/store/migrations/003_connector_credentials_and_ops_profiles.ts`: SQLite migrations for `connector_credentials` and `ops_profiles` tables.
  - `src/pipeline/store.ts` & `src/pipeline/store/sqlite.ts`: Per-client encrypted connector credentials storage and operator-confirmed `ops_profiles` storage in both `JsonProjectStore` and `SqliteProjectStore` with strict tenant isolation.
  - `src/pipeline/ops/connectors/{stripe,shopify}.ts` & `src/pipeline/stages/opsReporting.ts`: Removed all `process.env.STRIPE_*` and `process.env.SHOPIFY_*` fallbacks. Ingest loads per-client credentials and fails closed on decryption failure or missing credentials when synthetic data is not allowed.
  - `src/server/routes/adminCredentials.ts` & `src/server/routes/credentials.ts`: Admin routes (`/v1/admin/clients/:clientId/credentials/:connector`, `/v1/admin/clients/:clientId/ops-profile`) protected by `x-jantra-admin-token`, and tenant routes (`/v1/credentials/:connector`, `/v1/ops-profile`) strictly scoped to tenant.
  - Unit tests in `src/security/encryption.test.ts`, `src/pipeline/ops/credentials.test.ts`, `src/server/routes/credentials.test.ts`, and regression `ops-credential-isolation-and-decryption`.
- **HARD GATE ON PARTNER FIELD MAPPING:** Do NOT invent or synthesize partner-specific field mappings until real partner export (experiment X5) is provided and verified.

### T-019 — Real report delivery (P2, Medium, M)
- **Status:** Implemented (Signed Webhook Delivery Complete; Custom Provider Delivery Gated)
- **Implemented Code:**
  - `src/pipeline/stages/opsReporting.ts`: Real report delivery via signed webhook channel with HMAC-SHA256 signature (`X-Jantra-Signature`), SSRF protection via `assertPublicWebhookUrl` / `safeFetch`, transient retry handling, and provider response recording.
  - Delivery receipt records status `sent` on success or `failed` on error with HTTP status and provider response. NEVER marks failed or attempted delivery as sent. Produces `not_sent` when delivery is unconfigured.
  - Unit tests in `src/pipeline/stages/opsDelivery.test.ts` and regression `ops-webhook-delivery`.
- **HARD GATE ON PARTNER FIELD MAPPING:** Preserved until real partner export (experiment X5) is provided.

### T-020 — Promote intake to plan; gate queue UI (P2, Advanced, L)
- **Status:** Implemented (Code Complete)
- **Commit:** `7992930`
- **Implemented Code:**
  - `src/server/routes/runs.ts`: `POST /v1/runs/:runId/promote` endpoint (scoped to full keys) copies `idea_summary` artifact and creates a `planning-pipeline` run at `research: pending`.
  - Source run left untouched; audit logs `run_created` with `promotedFrom`.
  - UI updates in `web/src/routes/RunList.tsx`: Queue view for runs awaiting human action, lead inbox with "Promote" action.
- **Deployment & Acceptance State:** Pending Live Acceptance Gate #6 verification in production environment.

### T-021 — Lead notification and lead↔run link (P2, Medium, M)
- **Status:** Implemented (Code Complete)
- **Commit:** `258c149`
- **Implemented Code:**
  - `src/server/routes/leads.ts` & `src/server/schemas.ts`: `POST /v1/leads` accepts optional `runId`.
  - `src/runtime/gateEvents.ts` & `src/server/webhooks/dispatcher.ts`: Two new webhook event types: `lead.created` and `run.intake_completed`, signed with HMAC-SHA256 (`X-Jantra-Signature`).
  - Cloudflare Worker (`deploy/cloudflare-worker/worker.js`): Allows `POST /v1/leads`.
- **Deployment & Acceptance State:** Pending Live Acceptance Gate #5 verification with live CRM/Slack webhook endpoint.

### T-022 — Client-ready export (P2, Medium, M)
- **Status:** Implemented (Code Complete)
- **Commit:** `21c4e81`
- **Implemented Code:**
  - `src/server/export/clientReady.ts`: Generates print-styled HTML view of research report, PRD, TRD, and build plan with expandable claim citations, source links, and verified quotes.
  - `src/server/routes/runs.ts`: `GET /v1/runs/:id/export` endpoint.
  - UI button in `web/src/routes/RunDetail.tsx` providing client-ready view and browser "Save as PDF".
- **Deployment & Acceptance State:** Code complete; pending sample review by 3 target prospects before implementing automated PDF rendering pipeline.

### T-023 — Lead retention and deletion (P2, Medium, M)
- **Status:** Implemented (Code Complete)
- **Commit:** `c292fb9`
- **Implemented Code:**
  - `src/server/routes/leads.ts`: `DELETE /v1/leads/:id` endpoint (full scope or owning client).
  - `src/server/leads/store.ts` & `src/pipeline/store/sqlite.ts`: `deleteLead()` and `sweepExpiredLeads()` removing records older than `leadRetentionDays` (default 30).
  - Start-up sweep gated by `JANTRA_ENABLE_LEAD_DELETION_SWEEP` per Owner Decision D-6.
- **Deployment & Acceptance State:** Sweep feature flag must remain `0` in production until lead webhook notifications are proven live in production (Gate #5).

### T-024 — Operator UI token handling (P3, Small, S)
- **Status:** Implemented (Code Complete)
- **Commit:** `b32ce0d`
- **Implemented Code:**
  - `web/src/api/client.ts` & `web/src/routes/Settings.tsx`: API and admin tokens default to `sessionStorage` with an opt-in "Remember on this device" checkbox (`localStorage`).
  - Admin token is never re-rendered back into an input field.
- **Deployment & Acceptance State:** Code verified in web workspace; pending operator usability sign-off.

### T-025 — Real desktop licence verification (P2, Medium–Large)
- **Status:** Implemented (Code Complete)
- **Implemented Code:**
  - `src/licensing/`: Offline Ed25519 license verification with embedded public key, payload canonicalization, signature checking, expiry checks, file/memory stores, and `LicenseManager`.
  - `desktop/src/licensing.ts`: Offline Ed25519 verification with embedded public key; `activateLicense` and `licenseStatus` re-verifying cryptographically on every status read.
  - `scripts/issue-license.ts`: Owner license issuance CLI script with `--licensee`, `--plan`, `--days`, `--expires`, `--key`, `--verify`, and `--generate-keys`.
  - `src/server/routes/license.ts` & `src/server/app.ts`: `GET /v1/license` (re-verifies cryptographically), `POST /v1/license` (activation), and unlicensed read-only enforcement hook blocking run creation, stage advancement, and model completion calls when unlicensed/expired/tampered.
  - `desktop/src/providerConfig.ts` & `desktop/src/secrets.ts`: Multi-provider configuration supporting both Gemini and OpenAI-compatible providers, endpoints, models, data collection, and OS-backed encrypted credential storage.
  - `web/src/routes/Settings.tsx`: Displays active/unlicensed state, plan, licensee, and expiry date.
  - Tests: 9 unit tests in `src/licensing/licensing.test.ts`, plus regressions `desktop-licensing-enforcement` and `desktop-multi-provider-config` in `src/runtime/evals/regressions/server.ts`.
- **Deployment & Acceptance State:** Code complete; desktop typecheck passes; pending packaged desktop release verification.

### T-026 — Model catalog from configuration (P3, Small, S)
- **Status:** Implemented (Code Complete)
- **Commit:** `fc7b3bf`
- **Implemented Code:**
  - `src/model/catalog.ts`: Loads model catalog from optional JSON file at `JANTRA_MODEL_CATALOG_PATH`, validated against Zod schema, falling back to built-in list.
  - Server start-up logs warnings for any catalog models not listed by the active provider endpoint.
- **Deployment & Acceptance State:** Code complete and verified with unit tests.

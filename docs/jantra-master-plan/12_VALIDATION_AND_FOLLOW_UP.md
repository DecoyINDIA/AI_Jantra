# Current validation and follow-up

Validated on 2026-11-14 against implementation commit `d77df95`. This is the current status reference; documents 01-11 retain historical requirements and evidence. The owner states that Jantra is not in production. No deployment, partner-data acceptance, or production behavior was verified in this pass.

## Verified implementation

F-001 through F-007 were pushed. T-001 through T-017 and T-020 through T-026 have implementations, with the acceptance limits below. T-018/T-019 have encrypted credential and signed webhook frameworks but remain blocked for partner acceptance. Build remains disabled; billing remains deferred.

The local validation commands are `npm run typecheck`, `npm test`, `npm run eval`, `npm run smoke`, `npm run server:smoke`, and `npm run edge:verify:local`. Baseline after R-001, R-002, and R-003 verification and review findings resolution: 111 unit tests across 29 suites (all passed), 71 passed eval checks plus one intentionally skipped live judge, and 19 local edge checks. The local Worker harness exercises the Worker source and a simulated rate-limit binding; it does not prove deployed Cloudflare behavior. Existing CI configuration is present, but hosted CI runs and branch protection were not inspected.

## Commit evidence and report corrections

| Work | Implementation evidence |
|---|---|
| F-001 local-file cleanup | `f943e81` rewritten deployment/docs commit includes ignore rules; `e299fee` progress record |
| Live-judge credential check | `4a79c33` (its actual subject is `fix(eval): ensure live model judge requires valid credentials for active provider`) |
| F-002 credential and webhook security | `3fbff34` |
| F-003 licence issuance and file output | `7607974` |
| F-004 licence coverage | `65e35b9` |
| F-005 catalog isolation | `c84f073` |
| F-006 configuration/documentation | `18e815a` |
| F-007 worker/test isolation | `1fa20da`, `2bd7190`, `11a5c3b`, `b3906da`; final evidence record `d77df95` |

Actual source locations: operations profile routes are in `src/server/routes/credentials.ts` and `adminCredentials.ts`; licence coverage is in `src/licensing/licensing.test.ts` and server regressions; jobs are in `src/server/jobs/`; export rendering is `src/server/export/clientReport.ts`; the operator queue is `web/src/routes/HomeQueue.tsx`. Job terminal success is `done`, not `completed`.

Mechanical searches require interpretation: private-key marker strings occur in tests and documentation, legacy webhook field names occur in sanitizers and tests, connector credential names remain valid internal keys, and local HTTP tests inject fetch implementations. A literal zero-match assertion is inaccurate. No private PEM material or decrypted credential response was found in the reviewed current source. This is not an exhaustive security audit of every historical commit.

## Substantial correctness work: complete before retention enablement

### R-001: SQLite lead deletion retains personal data (Substantively implemented; sweep disabled pending operational verification)

Resolved in `src/server/leads/store.ts` (`SqliteLeadStore`), `src/pipeline/store/migrations/004_lead_deletion_records_and_requests.ts`, and `SqliteLeadStore.remediateSoftDeletedLeads`:
- Lead deletion permanently removes the lead row in SQLite and irreversibly purges personal data fields (`name, email, phone, idea, user_sub`) in one transaction.
- Minimal non-personal deletion audit records (`id, client_id, lead_id, run_id, deleted_at, action`) are stored outside the `leads` table in `lead_deletions` and in `system.jsonl` outside erased run audit trails.
- Pre-existing soft-deleted rows with residual personal data are remediated on migration and startup by migrating non-personal metadata to `lead_deletions` and purging personal rows.
- Finding 5 resolved: Silent `try/catch` error swallowing was removed in migration 004 and `remediateSoftDeletedLeads()`. Errors during soft-delete remediation (e.g. database errors or residual soft-deleted records) throw immediately and halt startup/migration, preventing false success claims. Verified with injected trigger errors.
- Backup/WAL retention runbook documented in `docs/runbooks/lead-retention-and-wal-checkpointing.md`: physical media erasure is not claimed from a SQL `DELETE` alone; operational WAL checkpointing (`PRAGMA wal_checkpoint(TRUNCATE)`) and 30-day backup rotation are formally defined.

### R-002: Manual sweep is global despite tenant authentication (Substantively implemented; sweep disabled pending operational verification)

Resolved in `src/server/routes/leads.ts` (`POST /v1/leads/sweep`) and `src/server/leads/store.ts`:
- `POST /v1/leads/sweep` derives tenant identity strictly with `requestClientId(request, deps.clientId)` and never accepts `clientId` from the request body.
- `sweepExpiredLeads` accepts `options.clientId`: when supplied, sweeps only records for that tenant. When omitted (scheduled daily cleanup), sweeps remain explicitly global.
- Multi-tenant isolation verified: tenant A's manual sweep leaves tenant B's expired records and linked artifacts intact in both SQLite and JSON stores.

### R-003: Linked deletion is not recoverable after partial failure (Substantively implemented; sweep disabled pending operational verification)

Resolved in `src/server/leads/store.ts`, `src/pipeline/orchestrator.ts`, `src/pipeline/store.ts`, `src/pipeline/store/sqlite.ts`, and migration 004:
- Replaced fragile lead-first deletion with durable deletion requests (`lead_deletion_requests` table and JSON queue) tracking `pending`, `processing`, `completed`, `failed`, and `cancelled` statuses with retry attempts.
- Finding 1 resolved: Queued `withRunLock` operations coordinate with deletion. `withRunLock` and `isRunLocked` track queue depth (`queueDepths`), while tracking deleted runs (`deletedRuns`). Deletion fails closed while active or queued operations exist; queued operations rejected due to deletion release their queue reservations; and operations queued after deletion reject cleanly.
- Finding 2 resolved: Durable step machine (`init` → `ownership_verified` → `project_deleted` → `jobs_deleted` → `audit_deleted` → `lead_deleted` → `completed`). Each step is persisted. If project deletion succeeds but subsequent steps fail, retry bypasses project existence/ownership checks (since the project is already gone) and safely completes remaining deletions. Tested failure after every step and recovery on restart.
- Finding 3 resolved: Safe retry mechanism on store startup retries failed deletion requests with bounded attempts (`maxAttempts: 5`), recovering transient failures while preventing poison requests from causing infinite crash/retry loops.
- Finding 4 resolved: Malformed JSON deletion queue fails closed with `StageFailedClosedError` and preserves exact original file bytes untouched without overwriting. Writes also guard against overwriting corrupt queue files by writing timestamped backups before failing closed.
- Finding 5 resolved: Remediation and migration failures surface directly rather than being silently caught and ignored.
- Review Issue 1 resolved (Startup recovery project store wiring): In `src/pipeline/store/sqlite.ts`, `SqliteProjectStore` passes `projectStore: this` to `SqliteLeadStore` (and `JsonProjectStore` accepts configured `baseDir` matching `projectDir`). During startup recovery, `SqliteLeadStore.processPendingDeletionRequests` uses the owning `SqliteProjectStore` rather than falling back to default store, ensuring artifact, source, and run directories in custom `projectDir` are thoroughly deleted.
- Review Issue 2 resolved (Surviving run protection & explicit cancellation/recovery): `markRunDeleted(runId)` is deferred until after Step 2 (`project_deleted`) succeeds rather than at `ownership_verified`. If Step 2 fails, `unmarkRunDeleted(runId)` clears any deletion flag, allowing active and queued operations on surviving projects to continue via `withRunLock`. Added explicit recovery (`retryDeletionRequest` with `force: true` bypassing max-attempt limits) and cancellation (`cancelDeletionRequest`, marking status `cancelled` and unmarking deletion lock) paths.
- Review Recovery Gap resolved (Cancellation refuses if removal has begun): `cancelDeletionRequest` in both `SqliteLeadStore` and `JsonLeadStore` verifies that the lead, the project record, and all linked artifact/source files still exist via `verifyProjectAndLinkedFilesExist`. If removal has begun (e.g. if the process stopped immediately after project deletion but before `project_deleted` was saved, or if artifact files were deleted), cancellation is strictly refused (`returns false`), preventing partially deleted runs and orphaned leads. Artifact inspection uses only the direct run-folder path written by `writeArtifactFile`; a copy in an unsupported subfolder cannot stand in for a missing artifact. Tested with simulated stop immediately after project deletion before step saving, successful cancellation for intact runs, and refusal when only a subfolder copy remains across both SQLite and JSON stores.
- Error sanitization resolved: Error messages stored in deletion requests and returned in HTTP 409 conflict API responses are sanitized via `sanitizeErrorMessage()` to a fixed safe string (`"Lead deletion failed closed. Retry after operator review."`), preventing any leakage of tokens, API keys, paths, or personal data.
- Shared run link awareness: checks for other active leads referencing the same `runId`; preserves shared run data still needed by other leads while deleting the target lead.
- Sweep configuration flag `JANTRA_ENABLE_LEAD_DELETION_SWEEP` remains disabled by default until durable notification acceptance.

## Security hardening pass (2026-11-18) and open findings

Security changes, their regressions and residual risks are recorded in `docs/THREAT_MODEL.md` (T1 to T18). Evidence: typecheck clean; `npm run eval` 84/84; `npm test` 111/111; desktop unit 7/7; real-Electron e2e 14/14 under xvfb; `npm run edge:verify:local` green; production dependency audit 0 advisories. None of this was validated against live Cloudflare, Render or a packaged desktop install.

Finding D-001 (desktop packaging, functional, pre-existing; resolved on branch `ccr-a978cd09-ujwn1j-desktop-packaging`, see the resolution note below): an unpacked Linux build (`electron-builder --linux dir`) contains only `desktop/dist` and the desktop package's own dependencies. electron-builder ignores the `../dist/**` and `../web/dist/**` globs in `desktop/electron-builder.yml` because they lie outside the app directory, so the packaged app has no web UI and no embedded API runtime or its dependencies (fastify, better-sqlite3 and others). `startApi()` imports `../../dist/server/app.js` and `webEntry()` reads `<appPath>/web/dist`, so an installed build cannot start the API. Fix outline: stage the root `dist` and `web/dist` into the desktop app directory before packaging (or ship them via `extraResources` and resolve them from `process.resourcesPath`), declare the runtime's production dependencies for the desktop package, `asarUnpack` better-sqlite3 and let electron-builder rebuild it for Electron's ABI in a dedicated release job (rebuilding in a shared checkout breaks the Node test suite). Acceptance: the packaged app starts, the UI loads, a run completes, and `desktop/test/electron-security.e2e.cjs` passes against the packaged build.

D-001 resolution. Packaging the app surfaced four further pre-existing defects, all fixed: (1) `import { autoUpdater } from "electron-updater"` crashed startup (CommonJS lazy exports); (2) a top-level `await app.whenReady()` in the ES-module entry deadlocked, so the app never became ready; (3) better-sqlite3 12.x does not compile against Electron 42 and has no prebuilds for it, so the desktop pins Node-API 13.0.3 (runtime suites pass on it; the server stays on 12.x for Node 20); (4) the UI could not run from `file://` (absolute asset paths, and `Origin: null` blocked by the API's CORS check), so it is served from `app://jantra/` with a CSP and the API allowlists exactly that origin. Runtime and UI are staged into the app (`desktop/scripts/stage.mjs`) for both dev and packaged runs; user data now lives in a `Jantra` folder; Electron fuses are hardened. Evidence: `desktop/test/packaged.e2e.mjs` passes 10/10 against an unpacked Linux build and against dev mode, a fused binary refuses `ELECTRON_RUN_AS_NODE`, and CI builds and tests the package. CI builds and launches unpacked Linux, Windows and macOS packages with asar integrity validation on; all three pass the 10 acceptance checks (macOS with Chromium's mock keychain, after a diagnostic run showed the cookie-encryption Keychain prompt blocking a headless launch). Not verified: signed installers (needs the owner's code-signing certificates).

Node 22 migration (branch `ccr-a978cd09-ujwn1j-node22`): the server image (`node:22-slim`), CI, `engines` and `.nvmrc` moved from Node 20 (end of life April 2026) to Node 22, and the root moved to better-sqlite3 13.0.3, removing the desktop override. Evidence: the production image was built and run (Node 22.23.5, non-root, no compiler in the runtime stage; health check healthy; 401 without a key, 403 for a public key without the edge secret; run created via the edge path; audit chain verified; the run survived a container restart on the data volume); full root suites, desktop unit tests and the packaged-app acceptance test pass. The image build here used a test-only wrapper adding the sandbox egress proxy; the repository Dockerfile itself is unchanged by that.

## External inputs and release acceptance

| Item | Required input/action | Completion evidence |
|---|---|---|
| X-001 / T-018 | Partner provides real export; produce manual X5 report, map observed columns and reconcile sources | Reviewed report, documented mappings, deterministic fixture derived safely from approved data |
| X-002 / T-019 | Owner-approved real webhook receiver and encrypted credentials | Receiver confirms signed payload, report hash and delivery id; retries/failures remain honest |
| X-003 | Future Render/Cloudflare access and deployment authorization; inspect actual services before migration | Backups, identified deployed revisions, persistence/restart, scope, visitor limits, promotion/export and long-stage acceptance |
| X-004 / T-022 | Three target prospects review sample export | Recorded feedback and accepted format; automated PDF pipeline stays deferred |
| Desktop / T-025 | Owner-controlled signing key matching embedded public key and packaged app test | Secure issuance, activation, expiry/tamper rejection, read-only inactive behavior and both provider setup flows in packaged app |

Do not regenerate a production signing key casually; confirm custody of the existing matching private key without printing it. A passing signature unit test uses test keys and does not prove owner custody. Keep production retention disabled until durable notification acceptance and R-001 through R-003 are complete. A generic signed webhook requires a compatible receiver or adapter; native Slack/CRM compatibility is not established by local HTTP tests.

## Execution and reporting rules

For each future authorized implementation task: add meaningful regressions, run required gates, commit a focused change, push `main`, and verify the remote hash. Preserve local user files. Do not rewrite pushed history. Record exact commands and observed counts; do not claim clean-clone, hosted CI, live delivery, deployment, or network-blocked validation unless it was actually performed.

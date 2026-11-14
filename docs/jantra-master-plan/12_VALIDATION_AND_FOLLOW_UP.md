# Current validation and follow-up

Validated on 2026-11-14 against implementation commit `d77df95`. This is the current status reference; documents 01-11 retain historical requirements and evidence. The owner states that Jantra is not in production. No deployment, partner-data acceptance, or production behavior was verified in this pass.

## Verified implementation

F-001 through F-007 were pushed. T-001 through T-017 and T-020 through T-026 have implementations, with the acceptance limits below. T-018/T-019 have encrypted credential and signed webhook frameworks but remain blocked for partner acceptance. Build remains disabled; billing remains deferred.

The local validation commands are `npm run typecheck`, `npm test`, `npm run eval`, `npm run smoke`, `npm run server:smoke`, and `npm run edge:verify:local`. Baseline: 95 unit tests across 29 suites, 70 passed eval checks plus one intentionally skipped live judge, and 19 local edge checks. The local Worker harness exercises the Worker source and a simulated rate-limit binding; it does not prove deployed Cloudflare behavior. Existing CI configuration is present, but hosted CI runs and branch protection were not inspected.

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

### R-001: SQLite lead deletion retains personal data

Confirmed in `src/server/leads/store.ts`, `SqliteLeadStore.deleteLead` and `sweepExpiredLeads`: SQL only sets `deleted_at`. Name, email, phone, idea, and user subject remain stored. JSON mode removes its file. Therefore API invisibility is implemented, but SQLite PII erasure and equivalent store semantics are not.

Fix: purge the lead row or irreversibly clear all personal fields within a transaction, retaining only a minimal separate deletion audit. Include already soft-deleted rows in the remediation. Verify raw SQL cannot retrieve submitted personal values after deletion/expiry. Define backup/WAL retention in the future operational runbook; do not claim physical media erasure from a SQL DELETE alone.

### R-002: Manual sweep is global despite tenant authentication

Confirmed: `POST /v1/leads/sweep` checks full scope but passes no tenant to `sweepExpiredLeads`; SQLite selects expired rows across all tenants and JSON scans every client directory. A full key for tenant A can trigger deletion for tenant B when the sweep flag is enabled.

Fix: add an explicit tenant filter for the manual endpoint, derived with `requestClientId`; keep the scheduled internal sweep explicitly global. Test tenant A's manual sweep leaves tenant B's expired records and linked artifacts intact in both stores.

### R-003: Linked deletion is not recoverable after partial failure

Confirmed: the lead is soft-deleted (or JSON file removed) before linked project/audit cleanup. Cleanup catches ownership-read and filesystem errors, and expired queries exclude soft-deleted leads. A failed cleanup can leave sensitive linked data without a retry path. Active job execution and multiple leads sharing a run also need explicit coverage before enabling cascades.

Fix: implement a durable deletion request with tenant-scoped targets and retryable steps; verify ownership positively and fail closed on unreadable ownership evidence. Coordinate with run locks/jobs so execution cannot recreate deleted artifacts. Only complete the deletion request when lead, linked project/jobs/files, and audit cleanup finish. Test injected filesystem/database failures, restart recovery, malformed audit ownership, missing runs, shared run links, and running jobs. Keep an ids-only deletion record outside the erased run audit.

These are substantial changes and were documented rather than implemented during the documentation pass. Keep the sweep disabled; do not describe T-023 as complete PII removal until R-001 through R-003 pass.

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

# Jantra Final Completion Brief

> Historical execution brief: F-001 through F-007 were executed and pushed through `d77df95`. The repository-state snapshot and rewrite instructions below describe the pre-execution state and must not be rerun. Current evidence, remaining correctness work, and external blockers are authoritative in [12_VALIDATION_AND_FOLLOW_UP.md](12_VALIDATION_AND_FOLLOW_UP.md).

**Date:** 2026-11-14  
**Repository:** `DecoyINDIA/AI_Jantra`  
**Branch:** `main`  
**Audience:** The implementation agent responsible for finishing Jantra without interpreting missing requirements  
**Production scope:** Production deployment is explicitly out of scope for this brief. Complete, verify, commit, and push the code to GitHub `main`. Do not deploy Render or Cloudflare and do not enable the production retention sweep.

---

## 1. Objective

Finish the Jantra master plan to the maximum extent possible without partner data or production access. Correct all confirmed defects listed in this brief, preserve Jantra's fail-closed and audit requirements, keep externally blocked work clearly marked as blocked, and leave GitHub `main` continuously updated.

This document is the single execution source for the remaining work. Do not declare the master plan complete merely because tests pass. Completion requires the behavior, security constraints, documentation, commit discipline, and push verification stated below.

---

## 2. Non-negotiable operating rules

1. Work directly on `main`. The owner has authorized pushing to GitHub `main` because Jantra is not currently in production.
2. Complete tasks strictly in the order in Section 7.
3. After **every task**:
   - Run that task's targeted tests.
   - Run the full required gate listed in Section 9.
   - Review the staged diff.
   - Create exactly one focused commit for that task.
   - Push the commit immediately with `git push origin main`.
   - Verify local `main` and `origin/main` point to the same commit.
   - Record the pushed commit hash in `PROGRESS.md` before starting the next task. If recording the hash requires a follow-up documentation commit, make and push that documentation commit immediately.
4. Never leave completed work only in the working tree or only in local commits.
5. Never combine unrelated tasks in one commit.
6. Never use `git push --force` after any commit has reached GitHub. The only permitted history rewrite is Task F-001, while the eight current commits are still local and unpushed.
7. Stop on any failing gate. Fix the failure in the same task before committing or pushing.
8. Do not weaken, skip, delete, or convert a failing check into a passing/skipped check to obtain a green suite.
9. Do not invent partner field mappings, production acceptance results, provider responses, delivery receipts, or deployment status.
10. Do not read `process.env` in new or modified runtime modules outside `src/config.ts`. CLI entrypoints under `scripts/` may read their own environment and pass values into pure modules.
11. Secrets must never appear in prompts, model messages, API responses, logs, audit records, artifacts, delivery receipts, error messages, or committed files.
12. Caller-supplied or stored URLs must use the shared guarded fetch path. Do not add raw dynamic `fetch()` calls.
13. All new API input must use a Zod schema and `parseWith`.
14. Every tenant operation must derive `clientId` from authenticated identity and enforce object-level tenant isolation.
15. Preserve local user files. Do not delete the user's working copies of `.agents/`, `.claude/settings.local.json`, or `.claude/skills/world-class-agents/`.

### Required per-task Git procedure

Run this sequence after each task, substituting the exact files and commit message for that task:

```powershell
git status --short --branch
npm run typecheck
npm test
npm run eval
npm run smoke
npm run server:smoke
npm run edge:verify:local
git diff --check
git add <only-the-files-owned-by-this-task>
git diff --cached --stat
git diff --cached
git commit -m "<task-specific conventional commit message>"
git push origin main
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short --branch
```

`git rev-parse HEAD` and `git rev-parse origin/main` must match. The final status must show `main...origin/main` with no ahead/behind count.

---

## 3. Current repository truth

At the start of this brief:

- Local `main` is at `10344ce` and is eight commits ahead of `origin/main`.
- The working tree is clean.
- The eight local commits are:

| Commit | Current purpose | Disposition |
|---|---|---|
| `b6c72f0` | Licence key rotation, live-judge failure behavior, exact mock fixtures | Keep, subject to fixes below |
| `c36d7b0` | Lead deletion and recurring retention sweep | Keep, subject to gates |
| `b385290` | Offline licensing and desktop provider configuration | Keep, subject to fixes below |
| `a6a1271` | Encrypted connector credentials and operations profiles | Keep, but secret APIs and profile storage must be corrected |
| `12c2a63` | Signed report webhook delivery | Keep, but destination and secret leakage must be corrected |
| `1ef14f7` | Deployment docs, edge harness, progress updates | Rewrite before first push because it accidentally includes local agent files |
| `50068ee` | Licensing module export/rootDir fix | Keep; hash will change after the rewrite |
| `10344ce` | Live-judge credential check | Keep; hash will change after the rewrite |

Current independently reproduced local gates:

- `npm run typecheck`: pass.
- `npm test`: 89 tests pass, but unit tests attempt live OpenRouter catalog requests. This is a defect to fix.
- `npm run eval`: 69 checks pass and one live judge check is intentionally skipped when disabled.
- `npm run smoke`: pass.
- `npm run server:smoke`: pass.
- `npm run edge:verify:local`: 19 checks pass.
- Explicitly enabling live judging without credentials makes the eval command fail, as required.
- No Ed25519 private key is currently present in tracked files.

---

## 4. Complete task inventory: T-001 through T-026

The status terms in this table are exact:

- **Complete:** Code is already on `origin/main` and the relevant local gates previously passed.
- **Local implementation pending push:** Code exists only in the eight local commits and must not be treated as durable until fixed and pushed.
- **Externally blocked:** Completion requires data or live infrastructure that is unavailable. Implement only safe framework work and keep the task marked blocked.
- **Production acceptance pending:** Code may be complete, but live validation is deliberately outside this brief.

| Task | Status at start | Required action in this brief |
|---|---|---|
| **T-001 Restrict public API keys** | Complete on `origin/main` | Preserve public/full scope enforcement and regressions. No new implementation unless a remediation breaks it. |
| **T-002 Ops pipeline honesty** | Complete on `origin/main` | Preserve fail-closed behavior and honest `not_sent`/`failed` receipts. Delivery fixes must not weaken this. |
| **T-003 Single persistent data root** | Complete on `origin/main` | Preserve data-root derivation. Add any newly required secret/config entries without changing paths. |
| **T-004 Guarded outbound fetch** | Complete on `origin/main` | All webhook delivery must continue through `safeFetch` and SSRF validation. |
| **T-005 Origin client address discovery** | Complete discovery | No code task. Preserve the trusted Cloudflare header design. |
| **T-006 Per-visitor limits** | Complete on `origin/main` | Preserve visitor isolation, trusted-header behavior, and budget ceilings. |
| **T-007 Clean error envelope** | Complete on `origin/main` | New secret and webhook errors must use clean error codes and must not contain secret values or full credential URLs. |
| **T-008 Store defects** | Complete on `origin/main` | Preserve safe path segments and exclusion of non-project files. |
| **T-009 Cross-platform scripts and CI typecheck** | Complete on `origin/main` | Keep all workspace typechecks blocking. New scripts must work on Windows and POSIX shells through Node/TypeScript entrypoints. |
| **T-010 Research checkpoints** | Complete on `origin/main` | Preserve checkpoint durability. |
| **T-011 Final report verification** | Complete on `origin/main` | Preserve deterministic provenance checks and fail-closed fallback behavior. |
| **T-012 Budget reserve/settle** | Complete on `origin/main` | Preserve exact fixture-based gateway regression and unknown-price guard. |
| **T-013 Documentation truth pass** | Complete previously, now stale | Reconcile documentation again in Task F-006 with the final commit hashes and honest status. |
| **T-014 Async stage execution** | Code complete; production acceptance pending | Preserve worker, job persistence, crash recovery, async routes, and tests. Do not claim live proxy-timeout acceptance. |
| **T-015 SQLite and migrations** | Code complete; production acceptance pending | Preserve migrations 001-003 and idempotency. Migration 003 must be updated if webhook credentials move into encrypted storage. |
| **T-016 Production container** | Code complete; production acceptance pending | No deployment in this brief. Ensure new configuration is represented in `render.yaml` and `.env.example`. |
| **T-017 Unit tests and split regressions** | Code complete but network isolation defective | Complete Task F-005 so all local tests are offline and deterministic. |
| **T-018 Per-client connector credentials** | Framework local; externally blocked | Fix credential exposure and encrypted secret boundaries. Keep partner-specific mappings blocked until X5 receives a real export. |
| **T-019 Real report delivery** | Framework local; externally blocked | Fix encrypted webhook configuration and all destination leakage. Keep live delivery acceptance blocked until X5 and a real receiver exist. |
| **T-020 Promote intake to planning** | Code complete; production acceptance pending | Preserve existing route, tenancy, source immutability, and regression. |
| **T-021 Lead notification/link** | Code complete; production acceptance pending | Preserve signed notification and PII-minimized event behavior. Do not claim a person or durable system received a production lead. |
| **T-022 Client-ready export** | Code complete; prospect validation pending | Preserve export behavior. Keep prospect validation outside this brief. |
| **T-023 Lead retention/deletion** | Local enhancements pending push; production enablement blocked | Preserve startup and daily sweep, tenant-safe linked deletion, and PII-minimized audit. Keep sweep disabled in production configuration. |
| **T-024 Operator token handling** | Complete on `origin/main` | Preserve session storage default and hidden admin token. |
| **T-025 Desktop licence verification** | Local implementation pending push | Complete Tasks F-003 and F-004. Preserve offline Ed25519 verification, expiry checking, and read-only unlicensed behavior. |
| **T-026 Configurable model catalog** | Complete on `origin/main`, test isolation defective | Complete Task F-005 so catalog verification never makes live requests during unit/eval tests. |

---

## 5. Confirmed bugs and exact required fixes

### B-001: Operations webhook secret is stored in plaintext

**Evidence:** `OpsReportingProfile.delivery.webhookSecret` is serialized inside `ops_profiles.data` without encryption.

**Failure:** Anyone who can read the SQLite database or profile API response can recover the HMAC secret.

**Required fix:**

- Remove `webhookUrl` and `webhookSecret` from the persisted operations profile.
- Store the report webhook configuration through the existing AES-256-GCM credential facility under the reserved credential connector id `report-webhook`.
- Store encrypted JSON with exactly `{ "url": string, "secret": string }`.
- The operations profile stores only `{ "channel": "none" | "webhook", "credentialRef"?: "report-webhook" }`.
- A webhook delivery request fails closed with a clean `StageFailedClosedError` if the referenced encrypted credential is missing, cannot be decrypted, has an invalid URL, or lacks a signing secret.

### B-002: Connector credentials are returned in HTTP responses

**Evidence:** Tenant and admin `GET .../credentials/:connector` routes return decrypted credential objects.

**Failure:** A full-scope API key or admin-token leak becomes a direct Stripe/Shopify credential extraction path. It also violates the T-018 contract that connectors are the only credential readers.

**Required fix:**

- Delete all API behavior that returns decrypted credential values.
- Connector runtime code may call `getConnectorCredentials` internally.
- API callers receive metadata only: connector id, configured boolean, and updated timestamp if available.
- Keep an administrative `PUT` for creating/replacing credentials and `DELETE` for removal.
- Tenant routes must never accept, return, or delete raw credentials. If the product needs a tenant status endpoint, it may list only configured connector ids.
- Add regressions proving no response body contains submitted secret strings.

### B-003: Full webhook destinations leak into messages, audits, and artifacts

**Evidence:** Delivery code includes the full URL in `ctx.io.say`, audit `url`, receipt `url`, and receipt `recipients`.

**Failure:** Slack, Zapier, Make, and similar webhook URLs commonly carry bearer tokens in the path or query. Those tokens become durable audit and artifact data.

**Required fix:**

- Never persist or display the full URL.
- Derive a safe destination label using only the parsed hostname, for example `webhook:hooks.slack.com`.
- Audit fields include `destinationHost`, `credentialRef`, `status`, `statusCode`, `deliveryId`, and `artifactHash`; they must not include URL path, query, fragment, secret, request body, or provider response body.
- Receipt artifacts use the same safe metadata and never list the raw URL as a recipient.
- User-facing messages say only that delivery to the configured webhook succeeded or failed.
- Convert network exceptions into stable error codes such as `unsafe_destination`, `timeout`, `network_error`, `http_4xx`, and `http_5xx`. Do not store raw exception messages when they may contain URLs.
- Do not store arbitrary provider response bodies. Store only status code and an allowlisted provider message id header if a supported provider contract defines one.

### B-004: Licence helper reads `process.env` outside `src/config.ts`

**Evidence:** `src/licensing/issue.ts` reads `JANTRA_LICENSE_PRIVATE_KEY` directly.

**Required fix:**

- Make `src/licensing/issue.ts` a pure library. `resolvePrivateKey` accepts only an explicit key path/value and never reads the environment.
- `scripts/issue-license.ts` may read `JANTRA_LICENSE_PRIVATE_KEY` and pass it into the library because it is a CLI entrypoint outside `src/`.
- Add a mechanical regression or check showing no new runtime `process.env` access was introduced.

### B-005: Licence key generation prints the private key to terminal output

**Evidence:** `--generate-keys` prints both public and private PEM values.

**Required fix:**

- Change key generation to require `--public-out <path>` and `--private-out <path>`.
- Refuse to overwrite an existing file unless an explicit `--force` flag is supplied.
- Create the private-key file with mode `0600` where supported.
- Print file locations and the public key fingerprint. Never print the private key.
- Document owner storage and rotation. Never commit generated private-key files.

### B-006: Unit tests perform real model-catalog network requests

**Evidence:** `npm test` logs OpenRouter catalog availability messages.

**Failure:** Offline tests become slow, noisy, and dependent on an external service. They may also send credentials during a local test run.

**Required fix:**

- Add `checkCatalogModels?: boolean` to `createServer` options.
- Production remote startup defaults this option to `true`.
- Local tests, regression apps, and smoke apps pass `false` explicitly unless a test is specifically validating catalog discovery with a mocked fetch.
- Do not make the production default depend on test heuristics, current directory, or an implicit `NODE_ENV` value.
- Add a test that constructs a server with checks disabled and asserts the catalog probe is not invoked.

### B-007: Local agent configuration was accidentally committed

**Evidence:** Commit `1ef14f7` added `.agents/skills/**` and `.claude/skills/world-class-agents/**`, although they were local user files outside the task scope.

**Required fix:**

- Complete Task F-001 before any push.
- Preserve the files on disk while removing them from Git history and the index.
- Add narrow ignore rules for `.agents/`, `.claude/settings.local.json`, and `.claude/skills/world-class-agents/`.
- Do not remove previously tracked `.claude/skills/agent-factory/` files unless a separate repository decision explicitly authorizes it.

### B-008: Deployment configuration omits new required variables

**Evidence:** The runbook mentions `JANTRA_SECRETS_KEY`, but `render.yaml` and `.env.example` do not include all new settings.

**Required fix:**

- Add `JANTRA_SECRETS_KEY` as `sync: false` in `render.yaml`.
- Add documented placeholders to `.env.example` for:
  - `JANTRA_SECRETS_KEY`
  - `JANTRA_RUN_LIVE_JUDGE`
  - `JANTRA_LICENSE_PUBLIC_KEY`
  - `JANTRA_LICENSE_PATH`
  - `JANTRA_LICENSE_TOKEN`
  - `JANTRA_LICENSE_ENFORCEMENT`
  - `JANTRA_LEAD_DELETE_LINKED_RUNS`
- Keep `JANTRA_ENABLE_LEAD_DELETION_SWEEP=false` in all deployment guidance until live lead delivery is accepted.
- State that a 32-byte AES key encoded as hexadecimal requires exactly 64 hexadecimal characters.

### B-009: Progress and pending documents contain stale commit/test data

**Required fix:**

- Update all new task rows with the actual pushed commit hashes after the fixes are on GitHub.
- Use `89/89 unit tests` and the final eval count actually printed by the suite.
- Distinguish `Implemented`, `Pushed`, `Production acceptance pending`, and `Externally blocked`.
- Never put `Verified Push: Yes` beside an unpushed commit or a placeholder commit.

---

## 6. External blockers that must remain open

### X-001: Partner export and experiment X5

No real partner CSV or spreadsheet is available. Therefore:

- Do not define partner-specific Stripe, Shopify, QuickBooks, Xero, or CSV field mappings.
- Do not claim T-018 is accepted.
- Do not claim T-019 is accepted.
- When the export arrives, manually create one report, document observed columns and meanings, reconcile overlapping sources, record data-quality problems, and only then write the final mapping packet.

### X-002: Live signed report delivery

There is no confirmed production receiver. Local mocked delivery proves code behavior only. Keep live delivery acceptance open until a real signed webhook is received by an owner-approved durable destination.

### X-003: Production deployment and retention enablement

Production deployment is outside this brief. Do not:

- Deploy to Render.
- Deploy or change the Cloudflare Worker.
- Migrate Railway data.
- Enable `JANTRA_ENABLE_LEAD_DELETION_SWEEP`.
- Claim persistence across a real redeploy.
- Claim live public-scope, visitor-limit, lead-delivery, promotion, export, or long-stage acceptance.

### X-004: Prospect validation of export

T-022 code is complete, but no evidence shows three prospects reviewed the exported brief. Keep product-format validation pending.

---

## 7. Ordered execution tasks

### F-001: Clean the unpushed Git history and protect local files

**Goal:** Remove accidental `.agents/` and `.claude/skills/world-class-agents/` additions before any local commit reaches GitHub.

**Procedure:**

1. Confirm `origin/main` is still `aea0e83` and local `main` contains only the eight listed commits.
2. Create a local safety branch at the current HEAD: `backup/pre-final-cleanup-2026-11-14`. Do not push this backup branch.
3. Start an interactive rebase from `aea0e83` and mark commit `1ef14f7` for edit.
4. At that commit, remove `.agents/` and `.claude/skills/world-class-agents/` from the index while preserving their working files.
5. Add the narrow `.gitignore` entries defined in B-007.
6. Amend the commit and continue the rebase.
7. Verify no commit in `aea0e83..HEAD` contains those paths.
8. Run the full gate.
9. Push rewritten `main` normally. A force push must not be needed because the eight commits were never on `origin/main`.

**Acceptance:**

- User files still exist locally.
- `git ls-files .agents` returns no files.
- `git ls-files .claude/skills/world-class-agents` returns no files.
- `git log --all -- .agents .claude/skills/world-class-agents` shows no occurrence on `main` after `aea0e83`.
- Local `main` equals `origin/main` after push.

**Commit:** Amended documentation/deployment commit during rebase. Push immediately after the full gate.

### F-002: Close all credential and webhook secret leaks

**Goal:** Implement B-001, B-002, and B-003 as one cohesive security boundary.

**Implementation:**

- Use encrypted credential id `report-webhook` for `{url, secret}`.
- Change profile schemas and storage to persist only `channel` and `credentialRef`.
- Remove decrypted credential response bodies from tenant and admin routes.
- Keep only admin create/replace/delete operations for secrets; tenant APIs may expose configuration status only.
- Resolve and decrypt credentials only inside connector/report execution.
- Redact destinations and normalize errors exactly as B-003 requires.
- Update migration behavior additively. Existing plaintext delivery settings, if found, must not be silently trusted or copied. Mark them unconfigured and require explicit operator re-entry through the encrypted route.

**Tests:**

- SQLite and JSON stores contain no submitted URL or secret in plaintext.
- Tenant A cannot detect or retrieve Tenant B's credential values.
- No admin or tenant API response contains submitted secrets.
- Success and failure audits contain no URL path, query, fragment, secret, report body, or response body.
- Delivery receipts contain safe host labels only.
- Missing, corrupt, or wrong-key encrypted webhook credentials fail closed.
- SSRF and redirect regressions remain green.

**Commit:** `fix(security): encrypt report webhook credentials and redact delivery metadata`  
**Push:** Immediately after the full gate.

### F-003: Make licence issuance pure and prevent terminal key disclosure

**Goal:** Implement B-004 and B-005.

**Implementation:**

- Remove environment reads from `src/licensing/issue.ts`.
- Move environment resolution to `scripts/issue-license.ts`.
- Replace terminal PEM output with explicit output files.
- Add overwrite protection and private-file permissions.
- Keep token signing, canonicalization, verification, expiry, and tamper behavior unchanged.

**Tests:**

- Issuing without `--key` or the CLI environment variable exits nonzero.
- A valid external key issues a token accepted by the matching public key.
- A different key yields `tampered` against the embedded public key.
- `--generate-keys` creates two files and stdout contains no private PEM.
- Existing private-key files are not overwritten without `--force`.
- Runtime source scan shows no new `process.env` access outside allowed entrypoints/configuration.

**Commit:** `fix(licensing): isolate private key handling and secure key generation`  
**Push:** Immediately after the full gate.

### F-004: Verify desktop licence enforcement and provider isolation

**Goal:** Finish T-025 acceptance at code level.

**Implementation checks:**

- Licence status re-verifies the token signature and expiry on every read.
- Unlicensed, expired, and tampered states allow read-only viewing/export but block run creation, advancement, interactions that trigger models, and `/v1/complete`.
- Activation remains authenticated by the normal server security layer.
- Gemini and OpenAI-compatible provider secrets are stored independently and never returned to the renderer.
- Desktop UI displays licensee, plan, expiry, and precise inactive state without displaying the token.
- `JANTRA_LICENSE_ENFORCEMENT` behavior is explicit for desktop packaging. A packaged desktop build must not accidentally disable enforcement because the environment variable is absent.

**Tests:**

- Cover active, expired, tampered, missing, and wrong-key licences.
- Cover every state-changing route that can cause a model call.
- Cover both provider configurations and secret isolation.
- Confirm API error is `403` with code `unlicensed` and contains no token data.

**Commit:** `test(licensing): complete desktop enforcement coverage` if no implementation changes are needed, otherwise `fix(licensing): enforce signed desktop licences consistently`.  
**Push:** Immediately after the full gate.

### F-005: Make every local test deterministic and offline

**Goal:** Implement B-006 and finish T-017/T-026 test isolation.

**Implementation:**

- Add the explicit catalog-check option to server construction.
- Disable the check in every test/eval/smoke server unless that test injects a mock catalog endpoint.
- Preserve the live production startup check.
- Do not convert catalog failures into silent success in production.

**Tests:**

- Run the complete suite with network unavailable.
- Assert zero catalog HTTP calls in ordinary unit/eval/smoke tests.
- Assert an explicitly enabled mocked catalog check still validates configured model ids.

**Commit:** `fix(test): prevent external catalog calls during local gates`  
**Push:** Immediately after the full gate.

### F-006: Complete configuration and documentation truth pass

**Goal:** Implement B-008 and B-009 after all earlier task hashes are known.

**Implementation:**

- Update `.env.example`, `render.yaml`, README configuration guidance, `PRODUCTION_CHECKLIST.md`, `PENDING_PACKETS.md`, and `PROGRESS.md`.
- Record final pushed commit hashes for F-001 through F-005 and the corrected T-023/T-025 framework commits.
- Mark T-018 and T-019 exactly as `Framework implemented; acceptance blocked by X5 and live delivery`.
- Mark production-dependent work as `Production acceptance pending`.
- State that the deletion sweep remains disabled.
- State that partner field mapping, production deploy, and prospect validation remain open.

**Tests/checks:**

- Every environment key read by new code is present in `.env.example`.
- Every Render-required secret appears in `render.yaml` with `sync: false`.
- No documentation claims a deployment, delivery, acceptance test, or push that did not happen.
- All commit hashes in progress tables resolve and are present on `origin/main`.

**Commit:** `docs(plan): reconcile final task status and deployment configuration`  
**Push:** Immediately after the full gate.

### F-007: Final repository acceptance

**Goal:** Prove that GitHub `main` is the complete, clean, reproducible code state allowed by current external inputs.

**Procedure:**

1. Start from a clean checkout of `origin/main` in a temporary directory.
2. Run `npm ci`.
3. Run every command in Section 9.
4. Run the mechanical security checks in Section 9.
5. Confirm no tracked private key, local agent directory, secret-bearing webhook destination, or decrypted credential response remains.
6. Confirm local working tree is clean and local `main` equals `origin/main`.
7. Update `PROGRESS.md` only if the reproduced results differ from its recorded values; commit and push that correction immediately.

**Commit:** No commit if documentation is already correct. If evidence changes, use `docs(plan): record final clean-checkout verification` and push immediately.

---

## 8. Required public interfaces after completion

### Connector credentials

- Administrative write/delete routes accept validated connector credentials.
- List/status routes return connector ids and configuration metadata only.
- No HTTP route returns decrypted secret values.
- Runtime connector execution retrieves credentials internally using authenticated tenant context.

### Operations profile delivery

```ts
interface DeliveryConfig {
  channel: "none" | "webhook";
  credentialRef?: "report-webhook";
}
```

The profile contains no URL or secret. The encrypted `report-webhook` credential contains the destination URL and HMAC secret.

### Delivery receipt

Receipt data may contain:

- `status`: `sent | failed | not_sent`
- `channel`: `webhook | none`
- `destinationHost`: hostname only
- `credentialRef`: `report-webhook`
- `deliveryId`
- `timestamp`
- `artifactHash`
- `statusCode`, when available
- Stable failure code, when failed

Receipt data must not contain:

- Full URL
- URL path/query/fragment
- HMAC secret or signature
- Connector credentials
- Report body
- Provider response body
- Raw exception text containing a URL

### Licence issuance

- Runtime library accepts explicit key material only.
- CLI resolves `--key` or `JANTRA_LICENSE_PRIVATE_KEY`.
- Key generation writes protected files and never prints the private key.
- Application embeds only the public key.

---

## 9. Full quality gate and mechanical checks

Every task must pass the relevant targeted tests plus this full gate before commit and push:

```powershell
npm run typecheck
npm test
npm run eval
npm run smoke
npm run server:smoke
npm run edge:verify:local
git diff --check
```

Run these additional checks before F-007 is accepted:

```powershell
# No private signing key in tracked content.
git grep -n "BEGIN PRIVATE KEY"
git grep -n "DEFAULT_OWNER_PRIVATE_KEY"

# No accidental local agent directories tracked.
git ls-files .agents
git ls-files .claude/skills/world-class-agents

# No connector environment fallbacks.
rg -n "STRIPE_API_KEY|SHOPIFY_ACCESS_TOKEN|SHOPIFY_SHOP_NAME" src/pipeline

# Review runtime environment access. No new entries outside config/entrypoint exceptions.
rg -n "process\.env" src --glob "*.ts"

# No raw dynamic fetch in server/pipeline paths.
rg -n "\bfetch\(" src/server src/pipeline --glob "*.ts"

# No secret-bearing webhook data in receipts or audits.
rg -n "webhookUrl|webhookSecret|recipients.*webhook|url:.*delivery" src/pipeline src/audit.ts

# GitHub synchronization.
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short --branch
```

Expected results:

- Private-key searches return no tracked secret material.
- Agent-directory `git ls-files` commands return no output for the specified local paths.
- Connector code has no environment credential fallback.
- Any remaining dynamic fetch is inspected and proven static or guarded.
- Webhook searches show only schema/type names or encrypted handling, never durable raw destination output.
- Local and remote commit hashes match.
- Working tree is clean.

---

## 10. Final completion criteria

The implementation agent may report this brief complete only when all of the following are true:

1. F-001 through F-007 are complete in order.
2. Every completed task has its own focused commit on GitHub `main`.
3. No completed task exists only locally.
4. All full-gate commands pass from a clean checkout of `origin/main`.
5. No private signing key exists anywhere in tracked history being pushed.
6. No HTTP API returns connector or webhook secrets.
7. No webhook URL path, query, secret, signature, report body, or arbitrary response body is persisted in audit or receipt artifacts.
8. Operations webhook configuration is encrypted at rest.
9. Local tests perform no real model-provider/catalog network calls.
10. `.agents/` and `.claude/skills/world-class-agents/` remain local and untracked.
11. Documentation contains resolvable pushed commit hashes and accurate test counts.
12. T-018/T-019 remain marked externally blocked until X5 and real live delivery occur.
13. Production acceptance and retention enablement remain explicitly pending.

---

## 11. Required final report format

Return one final report containing:

1. **Pushed commits:** task id, commit hash, and GitHub push confirmation for every F-task.
2. **Files changed:** grouped by F-task with one-line purpose.
3. **Tests:** exact commands and exit codes.
4. **Security proof:** searches showing no tracked private key, no secret-returning routes, no raw webhook destinations in durable output, and no accidental agent directories.
5. **Git proof:** identical `HEAD` and `origin/main` hashes plus clean status.
6. **Remaining external blockers:** X5 partner export, real receiver delivery, production deploy/acceptance, retention enablement, and prospect validation.
7. **No completion marker** for externally blocked items. Report them as blocked with the exact required input.

If any item above is absent, the work is not complete.

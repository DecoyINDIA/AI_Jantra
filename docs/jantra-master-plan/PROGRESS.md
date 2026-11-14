# Jantra Master Plan — Execution Progress Record

Initialized: 2026-11-13
Status: Implementation pushed through `d77df95`; retention correctness follow-up and external acceptance remain open. See [current validation and follow-up](12_VALIDATION_AND_FOLLOW_UP.md), validated 2026-11-14.

## Recorded Owner Decisions Applied
- **D-1**: Default public agent allowlist: `intake-public` (and route restriction).
- **D-2**: Render deployment target. Copy any leads and runs still on Railway before retiring Railway. T-003 scope unchanged.
- **D-3**: Lekha is active second track behind agency funnel: T-002 → T-015 → T-018 → T-019. Produce report manually from partner export before T-018. Waves 0 & 1 ahead of both tracks.
- **D-4**: Pricing deferred; no billing work scheduled.
- **D-5**: Desktop is a product. T-025 is P2 and requires licensing design pass with owner. Desktop typechecking blocks CI.
- **D-6**: 30-day retention. T-021 must be deployed and delivering leads to a person and durable system before T-023 deletion sweep.

---

## Task Execution Log

| Task | Priority | Status | Commit | Verified Push | Checks Run | Notes |
|---|---|---|---|---|---|---|
| **T-003** | P0 | Completed | d0b561f | Yes | G1 (46/46 eval, typecheck, smoke, server:smoke) | Single data root on persistent disk |
| **T-002** | P0 | Completed | 0736780 | Yes | G1 (48/48 eval, typecheck, smoke, server:smoke) | Ops pipeline honesty |
| **T-001** | P0 | Completed | 1644996 | Yes | G1 (49/49 eval, typecheck, smoke, server:smoke) | Restrict public API keys |
| **T-004** | P0 | Completed | 40120cb | Yes | G1 (50/50 eval, typecheck, smoke, server:smoke) | Outbound request guard (safeFetch) |
| **T-005** | P1 | Completed | - | Read-only | Discovery (Worker/Origin header flow) | Discovery: origin client address (see report below) |

### T-005 Discovery Findings
Historical pre-T-006 analysis only. The current Worker replaces the visitor header; these observations are not a current deployment test. No deployed client-address value was obtained during this documentation validation.
- **Header Analysis:**
  | Header Name | Value Seen Locally | Value Seen Deployed | Client-Controllable? |
  |---|---|---|---|
  | `X-Forwarded-For` | `203.0.113.9` (forwarded as-is) | Not available | Yes (passed through by Worker) |
  | `X-Jantra-Client-IP` | `203.0.113.9` (forwarded as-is) | Not available | Yes (passed through by Worker) |
  | `CF-Connecting-IP` | `198.51.100.42` | Cloudflare edge IP | No (set by Cloudflare edge) |
- **Answer A:** Is `request.ip` at the origin the visitor's address? **No.** Fastify's `trustProxy: 1` trusts only the immediate reverse-proxy hop (Render proxy). In production, Render's proxy connects to the container socket, resolving `request.ip` to Cloudflare's egress IP; thus, all public edge visitors would share a single IP bucket.
- **Answer B:** Can a browser client inject `X-Jantra-Client-IP` through the current Worker? **Yes.** `worker.js` creates `new Headers(request.headers)` and deletes only `Origin` and `Cookie`, forwarding any client-supplied `X-Jantra-Client-IP` directly to the origin.
- **Recommendation:** **CONFIRM** the T-006 design. `worker.js` must delete incoming `X-Jantra-Client-IP` and set it from `request.headers.get("CF-Connecting-IP")`. The origin must trust `X-Jantra-Client-IP` only when authenticated with `public` key scope.

| Task | Priority | Status | Commit | Verified Push | Checks Run | Notes |
|---|---|---|---|---|---|---|
| **T-007** | P1 | Completed | 0107546 | Yes | G1 (51/51 eval, typecheck, smoke, server:smoke) | Clean error envelope |
| **T-008** | P1 | Completed | 0f8fc48 | Yes | G1 (53/53 eval, typecheck, smoke, server:smoke) | Store defects |
| **T-009** | P1 | Completed | 1c8a17a | Yes | G1 (53/53 eval, typecheck, smoke, server:smoke) | Cross-platform scripts & CI typecheck |
| **T-010** | P1 | Completed | a233bb5 | Yes | G1 (54/54 eval, typecheck, smoke, server:smoke) | Persist research checkpoints |
| **T-006** | P1 | Completed | 16636c8 | Yes | G1 (57/57 eval, typecheck, smoke, server:smoke) | Per-visitor limits |
| **T-011** | P1 | Completed | cfcf245 | Yes | G1 (59/59 eval, typecheck, smoke, server:smoke) | Verify research report after refinement |
| **T-012** | P1 | Completed | 6ed82c6 | Yes | G1 (61/61 eval, typecheck, smoke, server:smoke) | Budget reserve/settle & unknown price guard |
| **T-013** | P1 | Completed | 5f9e017 | Yes | G1 (61/61 eval, typecheck, smoke, server:smoke) | Documentation truth pass |
| **T-016** | P2 | Implemented (Production acceptance pending) | 3239b8a | Yes | G1 + Docker smoke (/health 200, healthy) | Production container implemented; pending Render deployment rollout |
| **T-017** | P2 | Implemented (Pushed) | f57df4d | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Unit tests with node:test & split regression modules implemented and green |
| **T-021** | P2 | Implemented (Production acceptance pending) | 258c149 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Lead notification & lead↔run link implemented; pending live webhook verification |
| **T-020** | P2 | Implemented (Production acceptance pending) | 7992930 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Promote intake to plan & gate queue UI implemented; pending live promotion acceptance |
| **T-022** | P2 | Implemented (Production acceptance pending) | 21c4e81 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Client-ready print-styled HTML report & claims ledger implemented; pending prospect validation |
| **T-015** | P2 | Implemented (Production acceptance pending) | 23f80e1 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | One SQLite DB with migrations, mirrored columns, JSON import implemented; pending Render disk mount cutover |
| **T-014** | P2 | Implemented (Production acceptance pending) | d685952 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Async stage execution with in-process worker, jobs table, 202 Prefer: respond-async, SSE events implemented; pending live acceptance |
| **T-018** | P2 | Externally Blocked (Framework Implemented) | a6a1271 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Framework implemented; acceptance blocked by X5 and live delivery per D-3 |
| **T-019** | P2 | Externally Blocked (Framework Implemented) | 12c2a63 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Framework implemented; acceptance blocked by X5 and live delivery |
| **T-023** | P2 | Partial: correctness follow-up required | c36d7b0 | Yes | Local gates pass (95 unit, 70 eval plus one skipped judge) | SQLite soft deletion retains PII; manual sweep spans tenants; cleanup recovery needs work. See R-001 through R-003; keep sweep disabled. |
| **T-025** | P2 | Implemented (Pushed) | b385290 | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Offline Ed25519 verification, rotated embedded public key, pure issuance library, unlicensed read-only enforcement, multi-provider desktop config |
| **T-024** | P3 | Implemented (Production acceptance pending) | b32ce0d | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Operator UI token handling: sessionStorage default, remember checkbox, never re-render admin token |
| **T-026** | P3 | Implemented (Pushed) | fc7b3bf | Yes | G1 + npm test (95 unit tests, 70/70 eval) | Model catalog from JANTRA_MODEL_CATALOG_PATH with Zod validation, endpoint model verification, offline test isolation |

### Final Completion Execution Log (11_FINAL_COMPLETION_BRIEF.md)

| Task | Priority | Status | Commit | Verified Push | Checks Run | Notes |
|---|---|---|---|---|---|---|
| **F-001** | P0 | Executed | f943e81 | Yes | Historical gate record; current baseline in validation document | Rewritten docs commit includes ignore rules and removes accidental local paths. `4a79c33` is the live-judge credential fix, not a cleanup commit. |
| **F-002** | P0 | Completed | 3fbff34 | Yes | Full gate (90/90 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check) | Encrypted report webhook credentials under report-webhook, removed decrypted credentials from responses, safe host-only delivery receipt & audit metadata, fail-closed delivery |
| **F-003** | P0 | Completed | 7607974 | Yes | Full gate (92/92 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check) | Isolated private key handling in scripts/issue-license.ts, made src/licensing/issue.ts pure without process.env, enforced --public-out and --private-out flags with 0600 permissions, never print private key to terminal |
| **F-004** | P0 | Completed | 65e35b9 | Yes | Full gate (93/93 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check) | Verified desktop licence enforcement across all stage/model trigger routes (runs, advance, interactions, confirm, reject, promote, complete), authenticated activation, wrong-key & tampered rejection, provider secret isolation |
| **F-005** | P0 | Completed | c84f073 | Yes | Full gate (95/95 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check) | Added checkCatalogModels to createServer (defaults to true in production remote, false in local tests/smoke/regressions), zero external network calls during gates |
| **F-006** | P0 | Completed | 18e815a | Yes | Full gate (95/95 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check) | Reconciled environment configuration (.env.example, render.yaml), updated progress logs and pending packets with accurate pushed hashes, verified test counts (95 unit, 70 eval), recorded open external blockers |
| **F-007** | P0 | Completed | b3906da | Yes | Full gate in clean clone (95/95 unit, 70/70 eval, smoke, server:smoke, edge:verify:local, git diff --check, mechanical security checks) | Verified clean checkout in fresh temp dir, isolated JobWorker/catalog tests and regression apiKeys for deterministic offline execution, verified zero leaks and origin/main sync |


---

## Production Deployment Status & Live Acceptance Plan

### 1. Deployment Topology & Current Status
- **Planned architecture (not verified live):** Two-tier model:
  - **Public Edge:** Cloudflare Worker (`jantra-edge` / `xolver-intake-proxy` at `deploy/cloudflare-worker/`) exposing `https://api.jantra.in` (and `xolver.in` intake proxy).
  - **Private Origin:** Render Web Service (`jantra`, Docker container via `Dockerfile` and `render.yaml`) with 1 GB persistent disk at `/data/jantra`.
- **Status Distinction:**
  - **Code Status:** Local baseline passes: 95 unit tests, 70 eval checks plus one skipped live judge, both smoke commands, 19 local edge checks. Retention correctness remains open; Docker was not rebuilt in this pass.
  - **Production Deployment Status:** Owner states Jantra is not in production. Render cutover is future work. Any historical Railway endpoint, data, disk characteristics, or Cloudflare deployment must be inspected before planning a migration; none was verified here.

### 2. Account & Infrastructure Identification
The values below are intended configuration from repository files, not discovered account/resource identities.
- **Render Web Service:**
  - Service Name: `jantra`
  - Region: `singapore`
  - Plan: `starter`
  - Instance count: `numInstances: 1` (*Mandatory constraint: SQLite better-sqlite3 single-writer, in-process job worker, and run locks mandate a single instance*)
  - Persistent Disk: `jantra-data`, mounted at `/data/jantra`, size: 1 GB
  - Port: `JANTRA_SERVER_PORT=10000`
  - Healthcheck: `/health`
- **Cloudflare Edge Worker:**
  - Worker Name: `jantra-edge`
  - Domain / Route: `api.jantra.in/*` (or `xolver.in/api/intake/*`)
  - Upstream Origin: Private Render origin URL via `JANTRA_ORIGIN`
  - Secret: `JANTRA_API_KEY` matching the key of `JANTRA_REMOTE_API_KEYS` with subject `web`

### 3. Pre-Deployment Data Backup Procedure
Before redeploying the origin or migrating from Railway:
1. **Online SQLite Backup:** Because runtime container (`node:20-slim`) lacks native `sqlite3` CLI, invoke `better-sqlite3` online backup API via Node:
   ```bash
   node -e 'const Database = require("better-sqlite3"); const db = new Database("/data/jantra/projects/jantra.sqlite"); db.backup(`/data/jantra/backup-${Date.now()}.sqlite`).then(() => console.log("Backup complete"));'
   ```
2. **Snapshot Legacy JSON & Audit Logs:** Archive `/data/jantra/leads`, `/data/jantra/projects`, and `/data/jantra/audit` to a tarball.
3. **Verify Integrity:** Run `db.pragma("integrity_check")` and query record counts (`projects`, `leads`, `schema_migrations`) before redeploying.
4. **Off-Box Export:** Download snapshot archive to secure local storage.

### 4. Deployment Sequencing (Origin Before Edge)
- **Origin Deployment First:**
  1. Deploy Render origin with `render.yaml` configuration.
  2. Automatic schema migrations run on startup (`schema_migrations`, `jobs`, `leads`, `webhook_subscriptions`, `scope`).
  3. Verify `/health` returns 200 OK before routing edge traffic.
- **Edge Deployment Second:**
  1. Set `JANTRA_ORIGIN` and `JANTRA_API_KEY` in Cloudflare Worker.
  2. Deploy Worker with route allowlist (`/v1/runs`, `/advance`, `/interactions`, `/v1/leads`).
- **Rollback Order:** Reverse of deployment: rollback Edge first, then Origin.

### 5. Live Acceptance Verification Checklist
To mark production deployment accepted, the following 8 live gates must pass:
1. **Public Key Scope:** Key with subject `web` allows only intake routes and public agents (`intake-public`, `firebnb-concierge`). Requests to `GET /v1/runs` (tenant list), `/audit`, `/promote`, or non-public agents return 403 Forbidden.
2. **Persistent Leads Across Redeploy:** Lead submitted via `POST /v1/leads` survives a container restart/redeploy on Render and is present in `/data/jantra/projects/jantra.sqlite`.
3. **Independent Visitor Limits:** Origin receives visitor IP via `X-Jantra-Client-IP` injected exclusively by Cloudflare Worker from `CF-Connecting-IP` (client-supplied `x-jantra-*` headers stripped). One visitor reaching rate limit (15 req/60s) or daily budget ceiling does not affect other visitors.
4. **End-to-End Intake Completion:** Visitor completes full dialog on `xolver.in` (`POST /v1/runs` -> `advance` -> answer prompt -> `awaiting_confirmation` with `idea_summary` artifact -> lead capture).
5. **Signed Lead Webhook Notification:** Lead creation emits HMAC-SHA256 signed `lead.created` event with header `X-Jantra-Signature` to configured endpoint (Slack/CRM), alerting operator immediately without leaking personal fields into audit logs.
6. **Lead Promotion to Planning:** Full-scope operator calls `POST /v1/runs/:runId/promote`, creating planning pipeline run at `research: pending` with copied `idea_summary`, leaving source run intact and recording `promotedFrom` in audit.
7. **Client-Ready Report Export:** `GET /v1/runs/:id/export` produces print-styled HTML with formatted findings, PRD, TRD, architecture, and expandable citations/quotes, verified for browser "Save as PDF".
8. **Asynchronous Stage Execution:** Advance with `Prefer: respond-async` returns 202 Accepted with job ID; background execution finishes research stage beyond Cloudflare's 25s timeout; crash recovery re-queues and completes unfinished jobs upon container restart.

### 6. Retention Sweep Gating (Owner Decision D-6)
- `JANTRA_ENABLE_LEAD_DELETION_SWEEP` must remain `false` (`0`) in production until lead webhook notifications are proven live and actively delivering leads to a durable system of record.
- Only after successful delivery is proven and retention defects R-001 through R-003 are resolved may the owner enable the sweep with a 30-day retention period.

### 7. External Blockers Remaining Open (Out of Scope for Final Brief)
- **X-001 (Partner Export & Experiment X5):** No real partner CSV or spreadsheet is available. T-018 and T-019 framework implemented; partner-specific field mapping and live acceptance remain blocked per Decision D-3.
- **X-002 (Live Signed Report Delivery):** No confirmed production webhook receiver. Local mocked delivery proves code behavior; live delivery acceptance remains open.
- **X-003 (Production Deployment & Retention Enablement):** Production rollout to Render and live Cloudflare Worker deployment remain out of scope for this brief. Lead deletion sweep remains disabled (`JANTRA_ENABLE_LEAD_DELETION_SWEEP=false`).
- **X-004 (Prospect Validation of Export):** T-022 client-ready export implementation complete; product review by 3 target prospects remains open.

*Detailed operational runbook and commands: see [deploy/PRODUCTION_CHECKLIST.md](../../deploy/PRODUCTION_CHECKLIST.md).*


# Jantra Production Deployment & Verification Runbook

This document defines the production deployment requirements, operational procedures, and live acceptance verification checklist for deploying Jantra on **Render** (private Node origin) and **Cloudflare Workers** (public edge proxy).

---

## 1. System Architecture & Topology

```
[ Browser / Public Visitor on xolver.in ]
                    │
                    ▼  HTTPS (CORS restricted to xolver.in)
     [ Cloudflare Worker Edge (jantra-edge) ]
     • Holds JANTRA_API_KEY secret (browser never sees bearer key)
     • Allowlist routes only: /v1/runs, /v1/runs/:id, /advance, /interactions, /v1/leads
     • Injects X-Jantra-Client-IP from CF-Connecting-IP (strips incoming x-jantra-*)
     • Enforces per-IP rate limit (15 req/60s via RATE_LIMITER binding)
     • Request body cap: 16 KB (JSON only; 415/413 rejection)
     • Upstream timeout: 25 seconds
                    │
                    ▼  HTTPS (Private origin traffic with Authorization Bearer)
          [ Render Web Service (jantra) ]
          • Multi-stage Docker container (node:20-slim, non-root user `node`)
          • Persistent disk: 1 GB mounted at `/data/jantra`
          • Database: SQLite (better-sqlite3) at `/data/jantra/projects/jantra.sqlite`
          • Single instance (`numInstances: 1`) for file locks & in-process worker
          • In-process JobWorker for long stages (Prefer: respond-async)
          • HMAC-SHA256 signed webhook dispatch on `lead.created` & `run.intake_completed`
```

---

## 2. Account & Project Identification

### Render (Private Node Origin)
- **Account:** Xolver Production Team
- **Service Name:** `jantra`
- **Service Type:** Web Service (`type: web`)
- **Environment:** Docker (`./Dockerfile`)
- **Region:** `singapore` (recommended for lowest latency to primary Indian audience)
- **Plan:** `starter` (minimum recommended for 24/7 background worker & persistent disk support)
- **Instance Count:** **`numInstances: 1`** *(STRICT REQUIREMENT: Single SQLite writer, in-process job worker, and run locks mandate exactly one instance)*
- **Persistent Disk:**
  - Name: `jantra-data`
  - Mount Path: `/data/jantra`
  - Size: `1 GB` (or scalable as database grows)
- **Health Check Path:** `/health`
- **HTTP Port:** `10000` (`JANTRA_SERVER_PORT=10000`)
- **Historical Note (Railway cutover):** Railway origin `jantradesktop-production.up.railway.app` operated on ephemeral container storage without persistent disks. Any existing runs or lead data must be backed up before terminating Railway.

### Cloudflare (Public Edge Proxy)
- **Account:** Xolver Cloudflare Account
- **Worker Name:** `jantra-edge` (or `xolver-intake-proxy`)
- **Source:** `deploy/cloudflare-worker/`
- **Public Domain / Route:** `https://api.jantra.in/*` (or `https://xolver.in/api/intake/*`)
- **Bindings & Variables:**
  - `JANTRA_ORIGIN`: URL of private Render service (e.g. `https://jantra.onrender.com`)
  - `ALLOWED_ORIGINS`: `https://xolver.in,https://www.xolver.in`
  - `RATE_LIMITER`: Native ratelimit binding (`15 requests / 60 seconds`)
  - `JANTRA_API_KEY` (Secret): Matching the key part of `JANTRA_REMOTE_API_KEYS` on Render

---

## 3. Environment Variable & Secret Matrix

| Variable Name | Target Host | Classification | Description / Value |
|---|---|---|---|
| `NODE_ENV` | Render | Config | `production` |
| `JANTRA_SERVER_PORT` | Render | Config | `10000` |
| `JANTRA_DATA_DIR` | Render | Config | `/data/jantra` |
| `JANTRA_PROJECT_DIR` | Render | Config | `/data/jantra/projects` |
| `JANTRA_AUDIT_DIR` | Render | Config | `/data/jantra/audit` |
| `JANTRA_LEAD_DIR` | Render | Config | `/data/jantra/leads` |
| `JANTRA_OPS_DATA_DIR` | Render | Config | `/data/jantra/ops` |
| `JANTRA_PROVIDER` | Render | Config | `openai-compatible` (or `gemini`) |
| `JANTRA_BASE_URL` | Render | Config | `https://openrouter.ai/api/v1` (if openai-compatible) |
| `JANTRA_MODEL` | Render | Config | Fast intake model (e.g. `deepseek/deepseek-v4-flash`) |
| `JANTRA_MODEL_PRO` | Render | Config | Planning model (e.g. `deepseek/deepseek-v4-flash`) |
| `JANTRA_API_KEY` | Render | **Secret** | LLM endpoint key (e.g. OpenRouter `sk-or-v1-...`) |
| `GEMINI_API_KEY` | Render | **Secret** | Required for grounded research stage (`AIza...`) |
| `JANTRA_ADMIN_TOKEN` | Render | **Secret** | High-entropy secret for operator `/v1/admin/*` APIs |
| `JANTRA_REMOTE_API_KEYS` | Render | **Secret** | Format `<key>:xolver:web,<admin-key>:xolver:operator` |
| `JANTRA_PUBLIC_SUBJECTS` | Render | Config | `web` (subjects receiving public-scoped access) |
| `JANTRA_PUBLIC_AGENT_IDS` | Render | Config | `intake-public,firebnb-concierge` |
| `JANTRA_SECRETS_KEY` | Render | **Secret** | 32-byte hex key for encrypting client credentials at rest |
| `JANTRA_ENABLE_LEAD_DELETION_SWEEP` | Render | Config | **`false`** *(MUST remain false until lead delivery is proven live)* |
| `JANTRA_LEAD_RETENTION_DAYS` | Render | Config | `30` |
| `JANTRA_ORIGIN` | Cloudflare | Config | `https://jantra.onrender.com` |
| `ALLOWED_ORIGINS` | Cloudflare | Config | `https://xolver.in,https://www.xolver.in` |
| `JANTRA_API_KEY` | Cloudflare | **Secret** | `<key>` matching `JANTRA_REMOTE_API_KEYS` with `web` subject |

---

## 4. Pre-Deployment Data Backup Procedure

Before deploying new versions of the origin, changing Render disk configurations, or cutting over from Railway:

### A. SQLite Online Backup (Non-Blocking)
Because the runtime container runs `better-sqlite3` in WAL mode without native `sqlite3` CLI tools installed, execute SQLite's non-blocking online backup API via Node in the Render shell:

```bash
# Execute within the Render container terminal
node -e '
const Database = require("better-sqlite3");
const db = new Database("/data/jantra/projects/jantra.sqlite");
const backupPath = `/data/jantra/backup-${Date.now()}.sqlite`;
db.backup(backupPath)
  .then(() => {
    console.log("Online backup successful:", backupPath);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Backup failed:", err);
    process.exit(1);
  });
'
```

### B. Legacy JSON Leads & Audit Logs Snapshot
If legacy JSON files or audit records exist on disk:
```bash
tar -czf /data/jantra/snapshot-$(date +%Y%m%d%H%M%S).tar.gz \
  -C /data/jantra projects leads audit ops
```

### C. Verify Backup Integrity
Verify the database snapshot before proceeding:
```bash
node -e '
const Database = require("better-sqlite3");
const db = new Database("/data/jantra/<latest-backup>.sqlite");
console.log("Integrity Check:", db.pragma("integrity_check"));
console.log("Projects Count:", db.prepare("SELECT count(*) as c FROM projects").get());
console.log("Leads Count:", db.prepare("SELECT count(*) as c FROM leads").get());
console.log("Migrations:", db.prepare("SELECT name FROM schema_migrations").all());
'
```

### D. Download Offsite Copy
Download the backup archive to a secure local developer storage using Render SFTP or CLI before redeploying.

---

## 5. Deployment Sequencing: Origin Before Edge

**STRICT RULE: Origin MUST be deployed and verified healthy before deploying the edge Worker.**

### Why Origin First?
1. **Schema Migrations:** The origin automatically runs schema migrations on startup (`src/pipeline/store/migrations/`). New columns and tables (`jobs`, `leads`, `webhook_subscriptions`, `scope`, `allowed_agents`) must exist before traffic arrives.
2. **API Key Authentication:** The origin must be running with the updated `JANTRA_REMOTE_API_KEYS` before the edge begins using the new key.
3. **Route Availability:** If the edge enables forwarding for new routes (e.g. `POST /v1/leads`), an old origin would reject them with `404` or `405`.
4. **Zero-Downtime Rollout:** The origin serves both legacy and updated shapes gracefully; the edge switches external visitor traffic only when the origin is known healthy.

### Rollback Order
In case of rollback, reverse the order: **Rollback Edge First**, then **Rollback Origin**.

---

## 6. Live Verification Checklist & Acceptance Criteria

Execute this 8-point checklist immediately following production deployment:

### Check 1: Public Key Scope & Endpoint Isolation
- [ ] Make a direct request to the origin using the public edge key:
  ```bash
  # Must succeed (public intake route):
  curl -s -o /dev/null -w "%{http_code}" -X POST https://jantra.onrender.com/v1/runs \
    -H "Authorization: Bearer <public-key>" \
    -H "Content-Type: application/json" \
    -d '{"agentId":"intake-public","title":"Probe"}'
  # Expected: 200 OK

  # Must fail (tenant-wide list is forbidden to public scope):
  curl -s -o /dev/null -w "%{http_code}" https://jantra.onrender.com/v1/runs \
    -H "Authorization: Bearer <public-key>"
  # Expected: 403 Forbidden

  # Must fail (audit access is forbidden to public scope):
  curl -s -o /dev/null -w "%{http_code}" https://jantra.onrender.com/v1/runs/<runId>/audit \
    -H "Authorization: Bearer <public-key>"
  # Expected: 403 Forbidden

  # Must fail (non-allowed agent forbidden to public scope):
  curl -s -o /dev/null -w "%{http_code}" -X POST https://jantra.onrender.com/v1/runs \
    -H "Authorization: Bearer <public-key>" \
    -H "Content-Type: application/json" \
    -d '{"agentId":"planning-pipeline","title":"Illegal"}'
  # Expected: 403 Forbidden (agent_not_allowed)
  ```

### Check 2: Persistent Leads Across Container Redeploy
- [ ] Submit a lead via the public edge:
  ```bash
  curl -s -X POST https://api.jantra.in/v1/leads \
    -H "Origin: https://xolver.in" \
    -H "Content-Type: application/json" \
    -d '{"name":"Persistence Test","email":"test@xolver.in","idea":"Verification Lead"}'
  ```
- [ ] Verify `201 Created` with a returned `id`.
- [ ] Trigger a manual restart / redeploy of the Render container via Render Dashboard.
- [ ] Wait for `/health` to return `200 OK`.
- [ ] Verify via operator query (`GET /v1/leads` with full-scope admin key) or database inspection that the lead still exists on `/data/jantra/projects/jantra.sqlite`.

### Check 3: Independent Visitor Limits & IP Tracking
- [ ] Verify that `worker.js` strips client-injected `X-Jantra-Client-IP` and sets `X-Jantra-Client-IP: <CF-Connecting-IP>`.
- [ ] Send request with header `X-Jantra-Client-IP: 1.1.1.1` through Cloudflare edge.
- [ ] Inspect origin audit log: verify visitor IP recorded is the Cloudflare client IP, not `1.1.1.1`.
- [ ] Verify that reaching rate limits or visitor intake budget ($0.10/day) on one IP does not throttle requests from another distinct IP address.

### Check 4: End-to-End Intake Completion
- [ ] Complete full intake dialog via public widget on `xolver.in`:
  1. `POST /v1/runs` -> run created.
  2. `POST /v1/runs/:id/advance` -> returns `awaiting_input` with intake prompt.
  3. `POST /v1/runs/:id/interactions/:interactionId` -> submit project description.
  4. Response returns status `awaiting_confirmation` and generates `idea_summary` artifact.
  5. Submit visitor contact details linked to `runId` -> `POST /v1/leads` returns `201 Created`.

### Check 5: Signed Lead Webhook Notification
- [ ] Pre-configure webhook subscription for event `lead.created` pointing to destination endpoint (e.g. Slack bridge, CRM gateway) with a shared secret:
  ```bash
  curl -X POST https://jantra.onrender.com/v1/webhooks \
    -H "Authorization: Bearer <operator-key>" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://crm.xolver.in/webhook","events":["lead.created","run.intake_completed"],"secret":"<secret>"}'
  ```
- [ ] Trigger lead creation on `xolver.in`.
- [ ] Verify destination received HTTP POST with:
  - Header `X-Jantra-Event: lead.created`
  - Header `X-Jantra-Signature: <hex-hmac-sha256>`
  - Body containing `{ id, clientId, type: "lead.created", runId, payload: { leadId, runId, createdAt } }`
  - No plain-text secrets or personal fields leaked in audit trail.

### Check 6: Lead Promotion to Planning
- [ ] Operator executes promotion of completed intake run:
  ```bash
  curl -X POST https://jantra.onrender.com/v1/runs/<intakeRunId>/promote \
    -H "Authorization: Bearer <operator-key>"
  ```
- [ ] Verify `201 Created` returning new project ID.
- [ ] Verify new project has:
  - `agentId`: `planning-pipeline`
  - `currentStage`: `research` (stage `intake` marked `confirmed` with copied `idea_summary` artifact)
  - Source intake run remains untouched.
  - Audit log records `run_created` with `promotedFrom: <intakeRunId>`.

### Check 7: Client-Ready Report Export
- [ ] Fetch the client-ready HTML report for a planning run:
  ```bash
  curl -s https://jantra.onrender.com/v1/runs/<planningRunId>/export \
    -H "Authorization: Bearer <operator-key>"
  ```
- [ ] Verify `Content-Type: text/html; charset=utf-8`.
- [ ] Verify document contains print-styled HTML with:
  - Formatted research findings, PRD, TRD, and architecture.
  - Claims ledger with verified source citations, clickable URLs, and quotes.
  - Clean CSS styles optimized for browser "Save as PDF".

### Check 8: Asynchronous Execution for Long Stages
- [ ] Trigger a long stage (research) with `Prefer: respond-async`:
  ```bash
  curl -i -X POST https://jantra.onrender.com/v1/runs/<planningRunId>/advance \
    -H "Authorization: Bearer <operator-key>" \
    -H "Prefer: respond-async"
  ```
- [ ] Verify immediate response: `HTTP/1.1 202 Accepted` with payload `{ job: { id, kind: "advance", status: "queued" } }`.
- [ ] Verify execution continues in background via in-process `JobWorker` beyond Cloudflare's 25-second gateway timeout.
- [ ] Simulate container kill & restart during execution: verify `JobWorker.start()` calls `requeueRunningJobs()` and finishes the job cleanly.

---

## 7. 30-Day Retention Sweep Gating Policy (Owner Decision D-6)

> **CRITICAL OWNER DIRECTIVE (D-6):**
> Lead deletion sweep (`JANTRA_ENABLE_LEAD_DELETION_SWEEP`) **MUST NOT** be enabled in production until lead webhook notifications are proven live and actively delivering leads to a durable system of record (CRM, Slack, email).

### Verification Procedure Before Enabling Sweep:
1. Verify at least 3 consecutive live leads from `xolver.in` successfully dispatched signed webhooks.
2. Confirm receipt in the external destination system.
3. Once proven, update Render environment variables:
   - `JANTRA_ENABLE_LEAD_DELETION_SWEEP=true`
   - `JANTRA_LEAD_RETENTION_DAYS=30`
4. Deploy origin and verify startup log:
   `[jantra] Lead retention sweep completed: X expired leads swept.`

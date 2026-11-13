# 02 — Comprehensive Audit

Commit audited: `8a84143`. All findings are from reading code; none were reproduced by running the system. "Confidence" states how sure the reading is. Paths are relative to the repository root; line numbers refer to that commit.

## Severity summary

| ID | Finding | Severity | Confidence |
|---|---|---|---|
| A-01 | The public widget's service key can start any agent, with auto-approval and any catalog model | Critical | High |
| A-02 | Ops report "delivery" writes a receipt for an email that was never sent, to invented addresses | Critical (integrity) | High |
| A-03 | Ops ingest silently swaps in synthetic data when no real data loads; the reporting agent cannot find its KPI spec | Critical (integrity) | High |
| A-04 | Leads, ops CSVs and (by default) other data are written outside the persistent disk | Critical (data loss) | High for leads on Render |
| A-05 | SSRF guard bypass via IPv4-mapped IPv6, redirects and DNS rebinding; research fetcher has no guard | High | High (mapped IPv6), Medium (others) |
| A-06 | Origin rate limit and the daily intake budget are shared by all visitors | High | Medium — needs T-005 |
| A-07 | Budget checks are check-then-spend; cost can be recorded as $0 | Medium | High |
| A-08 | Research report is rewritten by a model after verification, with no re-check | Medium | High |
| A-09 | In-stage checkpoints never reach disk; long stages run inside one HTTP request | Medium | High |
| A-10 | 500 responses return internal error text; unknown agent id returns 500 | Medium | High |
| A-11 | Webhook file breaks run listing in JSON-store mode; two stores skip path-safety checks | Medium | High |
| A-12 | npm scripts are Windows-only; desktop is not typechecked in CI | Medium | High |
| A-13 | No unit tests; one 989-line regression file | Medium | High |
| A-14 | Container runs TypeScript via `tsx`, as root, with `npm install` | Low | High |
| A-15 | Docs contradict the code (Gemini-only rule, Claude references, Windows paths) | Low | High |
| A-16 | Stripe/Shopify credentials are process-wide, not per client | Medium (blocks multi-tenant ops) | High |
| A-17 | Lead PII stored as plaintext JSON with no retention or deletion path | Medium (compliance) | High |
| A-18 | Desktop licence check accepts any string matching a pattern | Low | High |

---

## 2.1 Security and data integrity

### A-01 — Public key can launch any agent, auto-approve gates and pin any model
**Evidence.**
- `deploy/cloudflare-worker/worker.js:84-95` forwards the browser's JSON body untouched and adds the service key.
- `src/server/schemas.ts:51-67` (`createRunBodySchema`) accepts `agentId` (default `planning-pipeline`), `modelId` (any catalog entry, including `claude-opus-4.8`, `gpt-4.1`) and `autonomy: "auto"`.
- `src/server/routes/runs.ts:49-76` applies the daily ideation budget only when `definition.id === "intake-public"`.
- `src/pipeline/orchestrator.ts:159-169` (`effectiveGate`) auto-confirms a stage when autonomy is `auto`, every artifact's eval passed (artifacts without an eval count as passed) and cost is under `JANTRA_COST_CEILING_USD` (default $10).
- `src/server/auth/apiKeys.ts:104-115` attaches only `{subject, clientId}`; there is no notion of what a key may do.

**Consequence.** Anyone who can reach the edge from an allowed origin (or replay the request with a forged `Origin` header from a script — the Worker checks the header, which non-browser clients set freely) can post `{"agentId":"planning-pipeline","autonomy":"auto","modelId":"claude-opus-4.8"}`, answer the intake questions, and have Research and Planning run unattended at up to $10 per run, 15 requests per minute per IP, outside the $0.50/day intake budget. They can equally start `ops-reporting` or `support-agent` runs. The edge blocks `/confirm`, but `autonomy: "auto"` makes confirmation unnecessary.

**Root cause.** Authorisation is modelled as tenancy only. The edge is treated as the security boundary, but it validates paths, not bodies, and the origin trusts whatever arrives with the key.

**Fix.** Task T-001: key scope on `Identity`; public-scope keys are limited to an agent allowlist, cannot set `autonomy` or `modelId`, and can call only the five run routes plus leads.

### A-02 — Fabricated delivery receipt
**Evidence.** `src/pipeline/stages/opsReporting.ts:719-766` (`runOpsDeliver`): computes recipients from a `profile` stage that does not exist in an `ops-reporting` project, otherwise invents `owner@<businessname>.com` or `owner@example.com`; says "Delivering operations report to …"; returns a `delivery_receipt` artifact with `channel: "email"` and a timestamp. No email, HTTP call or file write happens.
**Consequence.** The audit trail — the product's stated core promise — records a delivery that did not occur. If a client ever relies on it, this is a trust-ending defect.
**Fix.** Task T-002: the receipt must say `status: "not_sent"` until a real channel exists (T-019).

### A-03 — Silent synthetic data; reporting agent is structurally disconnected
**Evidence.**
- `opsReporting.ts:164-176`: when no connector returns records, the snapshot is replaced by `generateSyntheticData(clientId)`; the comment says "keeps tests/evals happy". Nothing in the artifacts marks the data as synthetic.
- `opsReporting.ts:59-69`: with no binding artifact, a hard-coded default binding is used (Stripe, an unsupported `quickbooks` type that is skipped at line 99, Shopify). Without env credentials both real connectors throw, the errors are audited, and the synthetic path runs.
- `opsReporting.ts:59`, `:251`, `:725`: the stages read `project.stages["source-binding"]`, `["kpi-design"]` and `.profile`. Those stage ids belong to the `ops-onboarding` agent (`src/agents/opsOnboarding.ts`); an `ops-reporting` project never contains them (`orchestrator.ts:72-79` builds stages from the run's own definition). `runOpsAnalyze` therefore throws "Required onboarding or ingest artifacts are missing." on every API-created reporting run.
**Consequence.** As registered, `ops-reporting` produces a data snapshot of fake numbers and then fails at analysis. If the lookup were patched without fixing the fallback, it would compose a confident report about invented revenue.
**Fix.** T-002 (fail closed, label origin). Linking onboarding output to reporting runs is a design decision deferred to the Lekha track (document 03, decision D-3).

### A-04 — Data written off the persistent disk
**Evidence.**
- `src/server/leads/store.ts:16`: `LEAD_DIR = process.env.JANTRA_LEAD_DIR ?? ".jantra/leads"` (relative to `/app`).
- `render.yaml` sets `JANTRA_PROJECT_DIR` and `JANTRA_AUDIT_DIR` under `/data/jantra` but not `JANTRA_LEAD_DIR`. It also omits `JANTRA_REMOTE_API_KEYS` and the Logto variables.
- `src/pipeline/ops/connectors/csv.ts:126`: `OPS_DATA_ROOT = path.resolve("data", "ops")` — also under `/app`, with no env override.
- `RAILWAY_ENV_FIX.md` records that the Railway container had no persistent volume at all, so runs disappeared on restart.
**Consequence.** On the Render blueprint every captured lead (name, email, phone, idea) is lost on each deploy or restart. Leads are the only revenue-relevant data the system currently produces.
**Fix.** T-003: one `JANTRA_DATA_DIR` root that every store derives from; blueprint updated.

### A-05 — SSRF guard gaps
**Evidence.** `src/server/webhooks/urlGuard.ts`:
- Lines 20-28: the IPv4-mapped check only matches dotted form (`::ffff:1.2.3.4`). Node's URL parser normalises `http://[::ffff:127.0.0.1]/` to hostname `[::ffff:7f00:1]`, which passes every test in `isPrivateIPv6` and is accepted. Also not covered: `100.64.0.0/10`, `198.18.0.0/15`, `64:ff9b::/96`, multicast.
- Lines 59-67: resolves DNS, then `delivery.ts:37` calls `fetch`, which resolves again (rebinding window) and follows redirects by default, so a public URL can 302 to `http://169.254.169.254/`.
- `src/pipeline/research/webFetch.ts:53-61` fetches URLs supplied by model grounding output with no address check and default redirect following.
**Consequence.** Blind SSRF from webhook delivery; content-returning SSRF from research (fetched text is fed to the model and can surface in a report). Reachability depends on the host's network; cloud metadata endpoints are the usual target.
**Fix.** T-004: one `safeFetch` using `net.BlockList`, manual redirects with re-validation, and a connection-time address check.

### A-06 — Shared rate-limit bucket and shared daily budget (hypothesis)
**Evidence.** `src/server/app.ts:70` sets `trustProxy: 1`; `rateLimit.ts:71-75` keys on `request.ip`. Traffic reaches the origin from Cloudflare's egress, so the address appended by the platform proxy is Cloudflare's, not the visitor's. The intake budget (`runtime/intakeBudget.ts`, default $0.50/day) is keyed by `clientId`, and every public visitor shares `clientId = "xolver"`.
**Consequence (if confirmed).** All visitors share 120 requests/minute at the origin, and one person can spend the day's intake budget and switch the widget off for everyone — a cheap denial of service against lead capture.
**Fix.** T-005 confirms what the origin actually sees; T-006 has the edge pass the visitor IP in a header the origin trusts only from a public-scope key, and keys limits and a per-visitor sub-budget on it.

### A-07 — Budget accounting
**Evidence.** `routes/complete.ts:27-74` checks the daily gateway budget, calls the model, then records spend — concurrent requests all pass the check. The per-call ceiling at `:76` only writes an audit entry. `config.ts:150-162` warns, but does not stop, when an OpenAI-compatible endpoint has no price configured and returns no `usage.cost`; every ceiling then compares against $0.
**Fix.** T-012.

### A-10 — Error handling leaks and misclassifies
**Evidence.** `src/server/errors.ts:63-69` returns `err.message` for any unrecognised error (file paths, SQL text, provider responses). `routes/runs.ts:52` calls `registry.get`, which throws a plain `Error` for an unknown id → HTTP 500 instead of 404. `routes/leads.ts` returns 500 if JWKS is unreachable at verification time only via the generic handler.
**Fix.** T-007.

### A-11 — Store defects
**Evidence.**
- `src/server/webhooks/store.ts:18-20` writes `webhooks.json` into `<projectDir>/<clientId>/`. `src/pipeline/store.ts:258-260` (`JsonProjectStore.listProjects`) treats every `.json` there except two spend files as a project; `normalizeProject` then calls `Object.values(project.stages)` on an array and throws. In JSON-store mode (local server without `JANTRA_ADMIN_TOKEN`) creating one webhook breaks `GET /v1/runs`.
- `webhooks/store.ts` and `leads/store.ts` build paths from `clientId` without `assertSafePathSegment`; `schemas.ts:108-113` lets an admin create a key whose `clientId` is `..`.
- Webhook secrets are stored in plaintext.
**Fix.** T-008.

### A-16, A-17, A-18
- **A-16.** `opsReporting.ts:108-112` and both connectors read `STRIPE_API_KEY`, `SHOPIFY_*` from `process.env`: one credential set for every tenant. Blocks any second ops customer. (T-018)
- **A-17.** `leads/store.ts` writes name, email, phone and idea as readable JSON; there is no deletion endpoint, retention period or export. India's DPDP Act and GDPR both expect a deletion path. (T-023)
- **A-18.** `desktop/src/licensing.ts`: `activateLicense` only tests `/^JANTRA-[A-Z0-9-]{8,}$/`. Harmless while the desktop app is not sold; misleading if it is. (T-025, owner decision)

## 2.2 Architecture and code quality

**Strengths (keep).** Clean provider seam; agent definitions snapshotted and hashed into each run; server-side gate enforcement; consistent Zod validation; typed error classes; small dependency surface; honest comments explaining why.

**A-08 — Verification can be undone by refinement.** `research.ts:553-581` (`refineReport`) asks the model to rewrite the report "using only the verified claims"; `:713-733` then checks the claim list, not the rewritten text. Any figure the refiner adds is unverified but ships under a "verified" label. The ops pipeline already has the right pattern (`verifyNumberProvenance`). (T-011)

**A-09 — Durability and request model.** `executionState.ts:10-17` only mutates the in-memory project; no stage file calls `saveProject`, so the "persist per-dimension results so the stage is re-entrant" intent of `DYNAMIC_WORKFLOWS_BRIEF.md` is unmet: a crash mid-research loses all progress and the cost already spent is never recorded. `/advance` and `/confirm` run whole stages inside the HTTP request (`routes/runs.ts:133-158`), which can take minutes and is cut off by any proxy timeout. The run lock (`orchestrator.ts:135-150`) is per process. (T-010 now; T-014 later)

**Persistence sprawl.** Six storage mechanisms for one small service: SQLite rows, project JSON files, artifact markdown files, audit JSONL, per-client JSON for webhooks and spend, per-lead JSON files. `SqliteProjectStore.listProjects` loads and parses every project blob for a tenant on each list call (`sqlite.ts:127-135`). (T-015)

**Oversized modules.** `regressions.ts` 989 lines, `opsOnboarding.ts` 795, `opsReporting.ts` 766, `research.ts` 742. `agents/support/reentrant.ts` and `agents/firebnb/reentrant.ts` are near-duplicates (404 vs 427 lines, identical line numbers for the same calls).

**Naming hazard.** `JANTRA_API_KEY` is the LLM vendor key; Jantra's own API keys are `JANTRA_REMOTE_API_KEYS`. `RAILWAY_ENV_FIX.md` shows this already caused a production incident.

## 2.3 Product

- **Intake widget.** Works as a conversation, but the handoff ends at "summary shown". There is no notification to Xolver when a lead completes, no link between a lead and its run, and no way for the operator to promote a finished intake into the full planning pipeline. The most valuable journey — visitor to proposal — stops halfway.
- **Operator UI** (`web/src`). Run list, run detail, agent catalog, keys, settings. No review queue of runs waiting at a gate, no artifact diff between versions after a rejection, no export (PDF/Docx) of the plan a client would receive. Tokens are pasted into a settings form and kept in `localStorage`.
- **Onboarding.** A new operator must know to set provider variables, generate keys with an admin token, and deploy an edge. No first-run check tells them what is missing (the project's own notes list "key-availability validation at run creation" as pending).
- **Complexity without matching value today.** Desktop shell with licensing, backup and auto-update for a product with no desktop customers; an 11-model catalog; a general LLM gateway (`/v1/complete`); the support demo agent.
- **Accessibility.** Not assessed in depth; the widget is vanilla DOM built with `createElement` and escapes text (`packages/embed-widget/src/index.ts:27`). A keyboard and screen-reader pass is a P3 item.

## 2.4 AI use

- Well placed: the intake interview, research synthesis under a deterministic verifier, critic loops, planning tournament.
- Correctly avoided: KPI maths and anomaly detection are deterministic code, with the model only narrating.
- Weak: prompt-injection defence is nine regular expressions (`policy.ts:47-57`) that also redact legitimate text such as "system prompt" in a source about LLMs. The structural defences (untrusted-content framing, verifier) matter more; do not invest further in pattern lists.
- Cost: skeptic pass is one call per verified claim; the tournament triples planning cost. Both are defensible for a paid deliverable and wasteful for a free one — route by run type (document 04 §7).

## 2.5 Operations and development

- **A-12.** `package.json:20,28-33` hard-code `npm.cmd`. (T-009)
- **A-13.** No unit tests for pure modules that deserve them (formula engine, anomaly engine, citation verifier, URL guard, CSV parser). (T-017)
- **A-14.** `Dockerfile`: `npm install` instead of `npm ci`, dev dependencies and `tsx` in the runtime image, root user, no healthcheck instruction. (T-016)
- **A-15.** `AGENTS.md` still orders "Gemini 2.5 only … no Anthropic/Claude, no OpenAI" and references `D:\XOLVER\…` paths; `docs/PRD.md` says "We build on Claude"; `.env.example` and README disagree with both. Agents following `AGENTS.md` literally would revert shipped features. (T-013)
- Twelve planning/kickoff documents in `docs/` describe finished work; they are history, not guidance, and should be archived so agents do not treat them as instructions.
- No error tracking, uptime check or cost alert. One `console.warn` is the only signal that a webhook failed.

## 2.6 Commercial findings (detail in document 10)

- There is no billing, plan or customer-quota code; the only monetised path is Xolver winning service work from widget leads.
- Idea-validation tools are crowded and cheap (free tiers; roughly $29/month paid tiers reported by vendor comparison pages). Automated Shopify/Stripe reporting exists at about €49–149/month. Both figures come from vendor and aggregator pages and are indicative only.
- Agency-intake chatbots exist as templates; none found pairs intake with cited research and a draft plan. That pairing is the gap the existing code already fills.

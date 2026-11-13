# 09 — Quality Gates

A task is complete when the gates pass on the orchestrator's machine, not when an agent says so.

## 1. Required return from every implementing agent
1. Files changed (path and one-line purpose)
2. Summary of changes
3. Tests executed (exact commands)
4. Actual results (exit codes and the relevant output lines, pasted)
5. Deviations from the packet, with reasons
6. Remaining issues
7. Evidence: the new regression ids and their pass lines

A report missing any item is returned unread.

## 2. Gate G1 — automated, every task
Run from a clean checkout of the task branch after `npm ci`:

```bash
npx tsc -p tsconfig.json --noEmit
npm run typecheck            # after T-009; before it, run the per-workspace typechecks CI uses
npm run eval
npm run smoke
npm run server:smoke
```
All must exit 0. These commands come from `package.json` and `.github/workflows/ci.yml`; they were not executed during planning, so the first run on unmodified `main` establishes the baseline. If the baseline is red, fix that before starting Wave 0.

Additional mechanical checks (scriptable; add to CI in T-017):
```bash
git diff --name-only main... | sort            # must be a subset of the packet's file list
grep -rn "process\.env" src --include="*.ts" | grep -v "^src/config.ts" | grep -v "evals/\|smoke.ts"
                                               # count must not increase versus main
grep -rn "channel: \"email\"" src              # must be empty after T-002
grep -rn "fetch(" src/pipeline src/server --include="*.ts" | grep -v safeFetch | grep -v fetchWithTimeout
                                               # after T-004: no raw fetch to dynamic URLs
```

## 3. Gate G2 — task acceptance
Each packet's numbered acceptance criteria are checked one by one by the orchestrator. A new behaviour without a new regression id in the eval report fails this gate regardless of what else passes.

## 4. Test layers

| Layer | What it proves | Where | When |
|---|---|---|---|
| Task-level regression | The specific defect cannot return | `src/runtime/evals/regressions.ts` (later `regressions/*.ts`) | Every task |
| Contract tests | HTTP status, error code and body shape for each route; public-scope allowlist; fixed 500 body | `src/server/smoke.ts` + scope/error regressions | T-001, T-007 onward |
| Integration | Full pipeline under the mock provider produces artifacts and verified claims | `npm run smoke` | Every task |
| Unit | Pure modules (formula, anomaly, verifier, net guard, CSV, provenance, limiter) | `src/**/*.test.ts` via `node --test` | From T-017 |
| Security checks | SSRF table, path-segment table, key-scope table, budget concurrency, no-leak 500 | Regressions added by T-001, T-004, T-007, T-008, T-012 | Every run of `npm run eval` |
| Edge verification | Worker allowlist, origin rejection, body cap, rate limit, header stripping | `npm run edge:verify` against a local Worker (`deploy/cloudflare-worker/README.md`) | Any change to `worker.js` |
| Performance sanity | Listing 1,000 runs under 200 ms on the SQLite store; research stage wall-clock not worse than baseline by more than 15% | Ad hoc script in the task branch, result pasted in the report | T-004, T-014, T-015 |
| Live-model evals | Quality has not regressed with real models | `npm run eval` with a real key, run by the owner | Before each production deploy that touches a stage |

## 5. Independent review (high-risk changes)

Applies to T-001, T-004, T-006, T-011, T-012, T-014, T-015, T-018.

A second agent of at least Medium tier, which has **not** seen the implementer's reasoning, receives only: the packet, the diff, and `07_AGENT_CONTEXT.md`. It answers five questions with file and line references:
1. Does the diff do everything the packet's steps say, and nothing else?
2. Name one input that the new regression does not cover and state what the code does with it.
3. Can any check added here be bypassed by a different route, method, header, encoding or code path? Show the path or say none found.
4. Does any change weaken an existing gate, ceiling, verification or tenancy check?
5. What breaks if this is deployed before, or without, its dependent change (edge versus origin, config versus code)?

Any "yes" to 3 or 4 blocks the merge. The reviewer does not rewrite code; findings go back to the implementer once, then escalate.

For T-001 and T-004 the owner additionally performs the manual checks in §7 before deploy.

## 6. Completion gates per milestone

| Milestone | Gate |
|---|---|
| M0 | G1 + G2 for T-001 to T-004; reviews passed; D-1 and D-2 answered; manual checks 7.1–7.4 done in production |
| M1 | G1 + G2 for T-005 to T-013; `npm run typecheck` green in CI on Linux; manual check 7.5 |
| M2 | A test lead on the live site produces a notification and can be promoted to a plan by an operator in under two minutes of operator time |
| M3 | Container runs as non-root from compiled output; one database file; `npm test` in CI; a stage longer than the proxy timeout completes |

## 7. Manual validation (owner, after deploy)

1. **Public scope:** with the edge's service key, `POST /v1/runs` with `{"agentId":"planning-pipeline"}` returns 403; with `{"agentId":"intake-public","autonomy":"auto"}` returns 403; the site widget completes an intake.
2. **Data root:** create a lead, redeploy the service, confirm the lead file still exists under `/data/jantra/leads`.
3. **Ops honesty:** start an `ops-reporting` run with no data configured; it must stop at ingest with "No operational data could be loaded", not produce a snapshot.
4. **SSRF:** `POST /v1/webhooks` with `http://[::ffff:127.0.0.1]/` and with `http://169.254.169.254/` both return 400.
5. **Per-visitor limits:** from two networks, send requests through the edge and compare `X-RateLimit-Remaining`; exhaust one visitor's budget and confirm the other still gets a run.

## 8. Rollback and recovery

| Change type | Rollback | Data concern |
|---|---|---|
| Code-only (T-002, T-007, T-008, T-010, T-011) | Redeploy previous image | None |
| Config-switchable (T-001, T-006, T-012) | Set `JANTRA_PUBLIC_SUBJECTS=`, `JANTRA_INTAKE_VISITOR_DAILY_CEILING_USD=0`, `JANTRA_ALLOW_UNPRICED_MODELS=true` — no deploy needed | None |
| Path change (T-003) | Old env variables still honoured; set them explicitly | Copy any files written to the new location back if rolling back |
| Edge (T-006, T-021) | `wrangler rollback`; always roll the edge back before the origin | None |
| Schema (T-015) | Migrations are additive; previous image ignores new tables and columns. Imported JSON folders are renamed, not deleted | Restore from the pre-deploy `sqlite3 .backup` if needed |
| Async jobs (T-014) | Stop sending the `Prefer` header | Mark queued jobs failed |

Before every production deploy: take `sqlite3 /data/jantra/projects/jantra.sqlite ".backup …"` and copy the leads folder. After every deploy: `/health`, one authenticated `GET /v1/agents` with a full key, one widget intake.

**Roll back immediately if:** the widget cannot create a run; any 5xx rate above 2% for five minutes; `cost_ceiling_exceeded` audit entries appear for a tenant that was under budget before the deploy; any artifact is produced that the previous version would have refused.

## 9. Orchestrator rules of thumb
- An agent's "all tests pass" without pasted output counts as not run.
- A regression that would also pass on unmodified `main` proves nothing: for Wave 0 tasks, run the new regression against `main` once and confirm it fails there.
- Never accept a change that deletes or loosens an existing regression to get to green.
- Prefer reverting to the last green integration commit over debugging forward under time pressure.

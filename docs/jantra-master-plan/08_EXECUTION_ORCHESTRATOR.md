# 08 — Execution Orchestrator

For the orchestrating agent (or person) running the task packets. Assumes one repository, one integration branch per wave, one task per branch.

## 1. Dependency graph

```
Wave 0 (P0)            Wave 1 (P1)                         Wave 2 (P2)                 Wave 3
T-001 ───────────────► T-006 ◄── T-005                     T-021 ──► T-020 ──► T-022
T-002                  T-007                                T-015 ──► T-018 ──► T-019    T-024
T-003 ───────────────────────────────────────────────────► T-015 ──► T-023
T-004                  T-008 ────────────────────────────► T-015                        T-026
                       T-009 ──► T-013                      T-016 (after T-009)
                       T-010 ────────────────────────────► T-014
                       T-011                                T-017 (after T-009)
                       T-012
                                                         T-025 (after T-009 + design pass)
```

**Critical path to "safe and honest" (M0):** T-001 → review → deploy. T-002, T-003, T-004 run alongside it.
**Critical path to the finished funnel (M2):** T-001 → T-003 → T-021 → T-020 → T-022.

Additional prerequisites from the 2026-11-13 decisions: T-021 must be deployed before T-023; T-018 requires the partner export report (X5) before building; T-019 also requires T-002. Wave 0 and Wave 1 stay ahead of both the agency funnel and Lekha tracks.

## 2. File-overlap map (decides what may run in parallel)

| File | Tasks that edit it |
|---|---|
| `src/runtime/evals/regressions.ts` | Every task (append one function + one array line) |
| `src/config.ts` | T-001, T-002, T-003, T-006, T-012 |
| `.env.example` | T-001, T-002, T-003, T-006, T-012, T-013 |
| `src/server/routes/runs.ts` | T-001, T-006, T-007 |
| `src/server/errors.ts` | T-007, T-012 |
| `src/server/app.ts` | T-006, T-007 |
| `src/pipeline/stages/research.ts` | T-010, T-011 |
| `src/pipeline/stages/opsReporting.ts` | T-002 only (T-012 does not touch it) |
| `src/server/leads/store.ts`, `webhooks/store.ts` | T-003 (leads), T-008 (both) |
| `src/pipeline/store.ts` | T-008 |
| `deploy/cloudflare-worker/worker.js` | T-006, later T-021 |

Rules derived from the map:
- `regressions.ts`, `config.ts` and `.env.example` conflicts are **append-only and mechanical**: accept both sides. Tell every agent to add its regression function immediately above `runRegressionEvals` and its array line at the end of the array, so merges are trivial.
- Never run two tasks in parallel that edit the same *route or stage* file.

## 3. Execution order

### Wave 0 — four agents in parallel
| Slot | Task | Tier | Notes |
|---|---|---|---|
| A | T-001 | Medium | Independent review mandatory |
| B | T-002 | Small | |
| C | T-003 | Small | Shares `leads/store.ts` with T-008 → T-008 waits |
| D | T-004 | Advanced | Independent review mandatory |

Merge order: T-003, T-002, T-001, T-004 (smallest config diff first). **Checkpoint C0:** all gates green on the integration branch, owner answers D-1 and D-2, deploy origin, then verify the widget on the live site completes one intake.

### Wave 1 — up to four in parallel, two rounds
| Round | Parallel set | Why this grouping |
|---|---|---|
| 1 | T-005 (discovery), T-007, T-008, T-009, T-010 | No shared route/stage files (T-007 owns `runs.ts`/`errors.ts`/`app.ts`; T-008 stores; T-010 research) |
| 2 | T-006 (after T-005 and T-007 merged), T-011 (after T-010 merged), T-012 (after T-007 merged), T-013 (after T-009 merged) | Each waits for the task that last touched its files |

**Checkpoint C1:** gates green; deploy origin, then edge (T-006 only); confirm from two networks that rate-limit headers are independent.

### Wave 2 — sequential pairs
T-016 and T-017 any time. T-021 → T-020 → T-022 in order. T-015 before T-014, T-018, T-023. Each outline needs its full packet written first (one strong-model pass per packet, roughly the size of T-006).

Deploy T-021 before T-023's 30-day deletion sweep. Lekha follows T-002 → T-015 → partner export report (X5) → T-018 → T-019, behind the agency funnel. T-025 is P2 and waits for T-009 plus a licensing design pass with the owner.

## 4. Agent assignment

| Tier | Use for | Tasks |
|---|---|---|
| Small / inexpensive | Mechanical edits with exact instructions, docs, config | T-002, T-003, T-005, T-007, T-008, T-009, T-010, T-013, T-016, T-024, T-026 |
| Medium | Several files, hook ordering, careful tests | T-001, T-006, T-012, T-017, T-021, T-022, T-023 |
| Advanced | Network edge cases, concurrency, data migration, false-positive control, signed licence verification | T-004, T-011, T-014, T-015, T-018, T-020, T-025 (after owner design pass) |

One agent per task. Do not create separate "backend", "testing" and "docs" agents for a single task: the packet already includes its tests and doc lines, and splitting would triple the context cost. The only standing specialist role is the **reviewer** (document 09 §5).

## 5. Batching

Batch into one agent session only where files and context are shared and each piece is small:
- T-007 + T-008 may be given to one small agent in sequence (both tiny, different files) if agent start-up cost matters more than wall-clock time.
- T-016 + T-026 likewise.
Do not batch any Wave 0 task: each needs an isolated diff for review and rollback.

## 6. Stable contracts to freeze before dependents start

| Contract | Defined by | Consumers |
|---|---|---|
| `Identity.scope`, `allowedAgentIds`, public route list | T-001 | T-006, T-015, T-020, T-021 |
| `config.dataDir`, `leadDir`, `opsDataDir` | T-003 | T-015, T-018 |
| `safeFetch(url, init, opts)` | T-004 | Any future outbound call |
| Error codes and fixed 500 body | T-007 | Widget, web UI, SDK |
| `X-Jantra-Client-IP`, `Project.visitorKey` | T-006 | T-021 |
| `checkpoint(ctx, state)` pattern | T-010 | T-014 |

Once merged, a contract changes only through a new packet that lists every consumer.

## 7. Handling results

1. **Receive the agent's report.** Reject immediately if any section of the report format is missing or "TESTS RUN" lacks real command output.
2. **Re-run the gates yourself** (document 09 §2) on the agent's branch. The report is a claim, not evidence.
3. **Diff check:** files changed ⊆ files the packet lists (plus `package-lock.json` only for T-004). Anything else → send back.
4. **Review** if the task is flagged for it.
5. **Merge**, then re-run the gates on the integration branch.

### Failures and retries
| Situation | Action |
|---|---|
| Gate fails, cause is inside the task's files | Return the failing output to the same agent once. Second failure → escalate to a higher tier with the packet, the diff and both failure logs. |
| Gate fails in an unrelated area | Stop. Check whether the integration branch itself is red before blaming the task. |
| Agent reports `ESCALATION` | Do not retry. A strong model reads the finding, amends the packet (or splits a discovery task off), and reissues. |
| Agent edits files outside the packet | Discard the branch; reissue with the violation quoted. |
| Two branches conflict in a route or stage file | The orchestrator's parallel grouping was wrong. Rebase the smaller task onto the merged one and re-run its gates; do not hand-merge logic. |
| Agent "fixes" a failing existing regression by editing it | Reject unless the packet explicitly allows adapting that regression. |
| Unexpected architectural finding (for example a second place that constructs identities) | Record it in `docs/DECISIONS.md` with the date, decide once, and add the decision to `07_AGENT_CONTEXT.md` so no later agent rediscovers it. |

Retry budget: at most two attempts at the assigned tier and one at the next tier. After that the packet is wrong, not the agent.

## 8. Cost controls

- Give each agent only `07_AGENT_CONTEXT.md` (about 2k tokens) and its packet (1–2.5k tokens). Do not attach the audit or architecture documents.
- Agents should open only the files their packet lists. A packet that needs more than about eight files read is too big; split it.
- Use the cheapest tier that the table in §4 allows; the gates, not the model, are the quality control.
- Decisions that must never be re-reasoned are in the context package's "Hard constraints" and "Known traps". Add to those lists whenever an agent trips on something new.
- Automated validation replaces review for all Small-tier tasks; human or strong-model review is reserved for T-001, T-004, T-006, T-011, T-012, T-014, T-015, T-018.

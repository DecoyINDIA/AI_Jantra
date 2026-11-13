# 05 — Master Roadmap

Audit references (A-xx) are in document 02. Task packets (T-xxx) are in `06_AGENT_TASKS/`. Complexity: S (under half a day for a competent agent), M (about a day), L (several days). Confidence is in the diagnosis and the proposed fix together.

## Milestones

| Milestone | Contains | Exit condition |
|---|---|---|
| **M0 — Safe and honest** | I-01 … I-04 | An anonymous caller cannot start anything but public agents; no artifact claims something that did not happen; leads survive a redeploy; SSRF regressions pass |
| **M1 — Reliable funnel** | I-05 … I-11 | Widget stays available under one abusive visitor; errors are clean; scripts and docs are correct for agents on any OS |
| **M2 — Finished funnel** | I-12, I-13, I-17, I-18 | A completed intake notifies Xolver, links to a lead, and can be promoted to a full plan and exported |
| **M3 — Scale-ready** | I-14, I-15, I-16, I-19 | Long stages survive proxy timeouts; one database; hardened container; unit tests in CI |
| **M4 — Optional / validate first** | I-20 … I-24 | Each starts only after its named decision or experiment |

Release strategy: ship M0 as one deploy (origin first, then edge) after owner review. M1 tasks deploy individually. M2 and M3 can interleave.

## P0 — Critical

### I-01 Restrict what a public key can do (T-001)
- **Problem / evidence:** A-01.
- **Solution:** key scope on identity; public keys limited to an agent allowlist, no autonomy, no model pin, seven routes.
- **Benefit:** removes unauthenticated cost abuse and access to non-public agents.
- **Complexity:** M. **Dependencies:** none; decision D-1 for the default allowlist. **Risk:** medium — a wrong default locks out a live site. **Confidence:** high.
- **Verify:** new regression `public-key-scope`; `npm run server:smoke`.
- **Success:** a public-scope request for `planning-pipeline`, `autonomy:"auto"` or `modelId` returns 403; widget flow unchanged.

### I-02 Ops pipeline tells the truth (T-002)
- **Problem / evidence:** A-02, A-03.
- **Solution:** fail closed when no real data unless mock provider or explicit flag; record data origin; delivery receipt reports `not_sent`.
- **Complexity:** S. **Dependencies:** none. **Risk:** low. **Confidence:** high.
- **Verify:** new regressions `ops-no-silent-synthetic`, `ops-delivery-honest`.
- **Success:** no code path emits `channel:"email"` without sending; synthetic data is impossible in non-mock mode without `JANTRA_OPS_ALLOW_SYNTHETIC=true`.

### I-03 All data on the persistent disk (T-003)
- **Problem / evidence:** A-04.
- **Solution:** `JANTRA_DATA_DIR` root; lead and ops dirs derive from it; blueprint and Docker updated.
- **Complexity:** S. **Dependencies:** D-2. **Risk:** low (old variables honoured). **Confidence:** high.
- **Success:** with only `JANTRA_DATA_DIR=/data/jantra` set, every write lands under it; verified by a regression that points the root at a temp dir.

### I-04 Outbound request guard (T-004)
- **Problem / evidence:** A-05.
- **Solution:** `safeFetch` with block list, manual redirects, connect-time check; used by webhooks and research.
- **Complexity:** M–L. **Dependencies:** none. **Risk:** medium (could block legitimate sources). **Confidence:** high for mapped-IPv6 and redirects.
- **Success:** regression rejects `http://[::ffff:127.0.0.1]/`, `http://100.64.0.1/`, and a local test server that redirects to loopback.

## P1 — High impact

| ID | Initiative | Evidence | Solution | Cx | Depends | Risk | Conf. | Verify / success |
|---|---|---|---|---|---|---|---|---|
| I-05 | Know the visitor's address at the origin (T-005 discovery, T-006) | A-06 | Edge sets trusted header; limiter and per-visitor budget key on it | S + M | I-01 | Low | Medium until T-005 | Two simulated visitors get independent buckets; one visitor cannot exhaust the client budget |
| I-06 | Clean error envelope (T-007) | A-10 | Fixed 500 message + request id; unknown agent → 404 | S | — | Low | High | Smoke asserts no stack/path text in any 5xx body |
| I-07 | Store defects (T-008) | A-11 | Exclude `webhooks.json` from listing; path-segment checks; tighten `clientId` pattern | S | — | Low | High | Regression creates a webhook then lists runs in JSON mode |
| I-08 | Cross-platform scripts, full CI typecheck (T-009) | A-12 | `npm.cmd` → `npm`; add desktop typecheck job | S | — | Low | High | `npm run typecheck` exits 0 on Linux CI |
| I-09 | Durable research checkpoints (T-010) | A-09 | Persist project after each checkpoint | S | — | Low | High | Regression: kill after one section, restart, section not re-run |
| I-10 | Verify the report after refinement (T-011) | A-08 | Deterministic number and citation-tag check on final text; fall back to unrefined draft | M | — | Medium | High | Regression: refiner injects a number → output equals pre-refine draft and audit has `guardrail_block` |
| I-11 | Budget correctness (T-012) | A-07 | Reserve/settle in a transaction; refuse to run with unknown price | M | — | Medium | High | Regression: 10 concurrent gateway calls cannot exceed ceiling by more than one reservation |
| I-12 | Docs agents can trust (T-013) | A-15 | Rewrite `AGENTS.md`, README env section, `.env.example`; archive finished kickoff docs | S | I-08 | Low | High | No instruction in `AGENTS.md` contradicts the code |

## P2 — Strategic

| ID | Initiative | Why | Cx | Depends | Validate first? |
|---|---|---|---|---|---|
| I-13 | Lead notification and lead↔run link (T-021) | A completed intake currently alerts nobody | M | I-01, I-03 | No |
| I-14 | Async stage execution (T-014) | Proxy timeouts on long stages | L | I-09 | No |
| I-15 | One database, with migrations (T-015) | Six storage mechanisms; listing parses every blob | L | I-03, I-07 | No |
| I-16 | Production container (T-016) | Root user, `tsx` at runtime, non-reproducible install | S | I-08 | No |
| I-17 | Promote intake to full plan + gate queue UI (T-020) | The main operator journey is missing | L | I-13 | No |
| I-18 | Client-ready export of plan and cited brief (T-022) | Deliverable must leave the operator UI | M | I-17 | Light: show three prospects a sample |
| I-19 | Unit tests and split regression file (T-017) | Cheap automated review for small agents | M | I-08 | No |
| I-20 | Per-client connector credentials (T-018) | A-16 | L | I-15 | Approved (D-3 = Yes, 2026-11-13); run experiment X5 with the partner's real export first |
| I-21 | Real report delivery (T-019) | A-02 follow-through | M | I-20 | Approved (D-3 = Yes) |
| I-22 | Lead PII retention and deletion (T-023) | A-17 | M | I-15, **I-13 must ship first** | No — 30 days (D-6, 2026-11-13) |
| I-27 | Real desktop licence verification (T-025) | A-18; desktop is a product (D-5 = Yes, 2026-11-13) | M–L | I-08 | Needs a licensing design pass before a packet is written |

## P3 — Optional

| ID | Initiative | Note |
|---|---|---|
| I-23 | Operator UI token handling (T-024) | Move from `localStorage` to session memory; low exposure today |
| I-24 | (moved) Desktop licence stub | Promoted to P2 as I-27 after decision D-5 |
| I-25 | Model catalog from configuration (T-026) | Avoid code edits for model churn; verify ids against the provider before each release |
| I-26 | Merge duplicate re-entrant runners; structured logs and metrics; widget accessibility pass | Do when touching those files |

## Success metrics

| Area | Metric | Target |
|---|---|---|
| Safety | Public-scope requests that reach a non-allowlisted agent | 0 |
| Integrity | Artifacts asserting an action that did not occur | 0 |
| Durability | Leads lost across a redeploy | 0 |
| Availability | Widget 429 rate for visitors under 5 requests/minute | under 1% |
| Cost | Runs whose recorded cost is $0 with a non-mock provider | 0 |
| Funnel | Completed intakes that produce a notification within 1 minute | 100% |
| Funnel | Intake → qualified call (business metric, document 10) | Baseline in first 30 days |
| Engineering | Wave tasks merged with all gates green on first review | at least 80% |

## Immediately actionable versus needs validation

- **Act now:** I-01 to I-12, I-16, I-19.
- **Owner answers received (D-1, D-2, D-3, D-5, D-6):** I-01, I-03, I-20, I-21, I-22 and I-27 are cleared to schedule in dependency order.
- **Act after a market signal:** I-18 format; any billing work (D-4 deferred by the owner).

# 03 — Strategic Optimization

## 1. The core problem with the current direction

The repository contains one sound runtime and five agents pointed at four different markets:

| Track | Buyer | State | Evidence of demand in the repo |
|---|---|---|---|
| Manthan intake widget | Xolver itself (lead capture) | Live | Production incident notes, lead endpoints, Logto attribution |
| Planning pipeline | Xolver operators; possibly founders | Works, operator-only | Heaviest investment (research, tournament, evals) |
| Lekha ops reporting | SMB owners | Prototype, not runnable end to end | None; synthetic fixtures only |
| FireBNB concierge | A separate product | Deployed | Two redeploy commits |
| Agent studio (PRD) | SMB/mid-market back offices | Document only | None |

The PRD names the Operations agent as the wedge. The commit history shows effort went to the planning pipeline and intake. Both cannot be the wedge, and a team this size cannot finish both. Effort is currently being spent on breadth (desktop licensing, an 11-model catalog, an LLM gateway, a second and third agent family) while the one live funnel loses leads on redeploy and can be driven to run $10 jobs by anonymous traffic.

## 2. First-principles questions

**Is the right problem being solved?** The PRD's problem (repetitive back-office work) is real but is the hardest version to deliver: each client needs bespoke integrations, credentials, and trust earned on live money data. The problem the code actually solves well — turning a vague idea into a researched, checkable brief — is narrower, needs no client integrations, and Xolver has the problem itself every time a prospect writes in.

**Is the architecture appropriate?** Yes for the scale. A single Node process with SQLite on a disk is the right size for tens of runs per day. It becomes wrong at the point of multiple instances or long-running jobs behind proxy timeouts; that is one targeted change (async execution), not a rebuild.

**Could something simpler outperform it?** For intake alone, a form plus one LLM call would capture leads. The pipeline earns its complexity only if the researched plan is delivered to someone who values it. Today it is not delivered to anyone outside the operator UI. The missing piece is product, not engineering.

**What would stop commercial success?** (a) Trust failures in the trust product — A-02/A-03 are exactly that; (b) no path from lead to revenue; (c) splitting effort; (d) competing head-on in idea validation, where free tools set the price.

**Where is effort wasted?** Desktop shell features with no desktop customer; Lekha polish before a single real data source or design partner; model catalog breadth; duplicate re-entrant runners.

## 3. Options compared

Scores 1 (poor) to 5 (strong). "Fit" means how much existing code is reused.

| Option | Feasibility | Commercial potential | Build cost | Risk | Fit | Notes |
|---|---|---|---|---|---|---|
| **A. Agency intake-to-proposal engine** — widget → cited brief → gated plan → proposal; Xolver first, then white-label to other agencies | 5 | 4 | Low | Low | 5 | Uses widget, edge, keys, tenancy, pipeline as built. Revenue first from Xolver's own conversion, then SaaS. |
| B. Founder self-serve idea validator | 4 | 2 | Medium | Medium | 4 | Crowded, free tiers, low willingness to pay; needs sign-up, billing, marketing engine. |
| C. Lekha ops reporting SaaS | 2 | 3 | High | High | 2 | Needs credential vault, OAuth connectors, scheduling, delivery; incumbents at €49–149/month. Differentiator (number provenance) is real but unproven with buyers. |
| D. Agent studio per the PRD | 2 | 4 | High per client | High | 3 | Services business; each engagement bespoke; no reference customer; long path to repeatability. |
| E. Open-source the runtime as a "trustworthy agent" framework | 3 | 1 | Medium | Medium | 4 | Many frameworks exist; no direct revenue. |

## 4. Recommendation

**Commit to Option A for the next two release cycles. Keep C alive only as a gated experiment. Do not start B, D or E.**

Reasons:
1. It is the only option where the customer already exists (Xolver's inbound leads) and the measure of success is available immediately (lead → qualified call → signed project).
2. It needs no new integrations and no client credentials.
3. The verification and audit work becomes visible value: a prospect receives a brief where each market claim opens the source quote. Template chatbots cannot copy that quickly.
4. White-labelling is mostly configuration: `clientId` tenancy, API keys, the edge Worker's origin allowlist and the widget's theme tokens are already there.
5. It keeps Option D open. An agency that trusts Jantra with intake is the natural first buyer of a custom agent later.

**What this means concretely**
- Finish the funnel: lead notification, lead-to-run link, one-click "promote intake to full plan", operator review queue, client-ready export.
- Fix the trust and safety defects first (Wave 0), because the positioning is trust.
- Freeze: model catalog growth, `/v1/complete` expansion, the support demo, forecasting. (Desktop was on this list until decision D-5; see section 5.)
- Lekha: make it honest (T-002) first. Decision D-3 (2026-11-13) confirmed a design partner, so it continues as a second track; see section 5.

## 5. Decisions that need the owner

| ID | Decision | Default if no answer | Blocks |
|---|---|---|---|
| D-1 | Which agents may the public service key start? | **Decided 2026-11-12: `intake-public` and `firebnb-concierge`** | — (resolved) |
| D-2 | Production host and disk: Railway or Render? | **Decided 2026-11-13: Render**, disk at `/data/jantra` per `render.yaml` | — (resolved). Still to confirm at cutover: leads and runs on Railway are copied before Railway is retired |
| D-3 | Is there a named Lekha design partner with exportable data within 30 days? | **Decided 2026-11-13: Yes** → Lekha is an active second track, not frozen | Unblocks T-018, T-019 (after T-015) |
| D-4 | White-label pricing test: per-seat, per-qualified-lead, or flat? | **Deferred by owner 2026-11-13**; revisit after experiments X3/X4 in document 10 | Billing work (not scheduled) |
| D-5 | Is the desktop app a product? | **Decided 2026-11-13: Yes** → licence check must be real before any sale | T-025 becomes an implementation task (see `PENDING_PACKETS.md`) |
| D-6 | Retention period for lead PII | **Decided 2026-11-13: 30 days**, delete on request | T-023 uses `JANTRA_LEAD_RETENTION_DAYS=30` |

### What the 2026-11-13 decisions change

- **Lekha (D-3 = Yes).** Section 4's "stop until D-3 is answered" no longer applies. Lekha runs as a second track behind the agency funnel, in this order: T-002 (honesty) → T-015 (one database) → T-018 (per-client credentials, plus the link from onboarding output to reporting runs) → T-019 (real delivery). Experiment X5 in document 10 becomes the acceptance test: one real report for the partner from their own export, by hand if needed, before T-018 is built. The risk named in section 1 (two wedges, one small team) is now a chosen trade-off; keep Wave 0 and Wave 1 ahead of both tracks.
- **Desktop (D-5 = Yes).** Desktop leaves the freeze list. Three things follow: the desktop typecheck in T-009 must be blocking, not optional; the licence stub (Audit A-18) is now a real defect to fix before the first sale; and the desktop app can only use Gemini today (`desktop/src/main.ts` reads one key), which needs a product decision before it is sold alongside a multi-provider server.
- **Retention (D-6 = 30 days).** Short enough that leads must reach a person and a durable system of record (CRM or email) quickly: T-021 (notification) must ship before T-023 (deletion sweep), or leads will be deleted unread.

## 6. Prioritisation rationale

Order of work follows four rules:
1. **Stop the bleeding before building**: cost abuse (A-01), false records (A-02, A-03), data loss (A-04), SSRF (A-05).
2. **Protect the one live funnel**: availability and budget fairness (A-06, A-07), error hygiene (A-10).
3. **Make agents cheap to direct**: fix scripts and docs (A-12, A-15) early, because every later task is executed by small agents that read `AGENTS.md` and run `npm` scripts.
4. **Then finish the funnel**, then architecture that only matters at scale (async jobs, store consolidation, container hardening).

Anything that needs a customer signal before it is worth building is marked "validate first" in the roadmap and has an experiment in document 10.

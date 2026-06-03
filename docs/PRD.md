# Jantra AI — Product Requirements Document

| | |
|---|---|
| **Product** | Jantra AI ("machine AI", from *yantra/jantra* = machine) |
| **One line** | Jantra AI builds autonomous agents that run the back-office work no one wants to babysit. |
| **Status** | Draft for review and finalization |
| **Version** | 0.1 |
| **Date** | 2026-06-02 |
| **Owner** | Founder (Xolver) |
| **Repo** | `D:\XOLVER\Mainframe` (product folder; GitHub `DecoyINDIA/AI_Jantra`). Marketing demo lives separately in `Xolver\...\templates\mainframe`. |

---

## 1. TL;DR

Jantra AI is an **agentic AI studio**: we design, build, and operate autonomous agents that take over repetitive back-office operations for SMB and mid-market companies. We start as a **done-for-you studio** (we build each agent by hand on a shared runtime), earn services revenue, and productize the runtime into self-serve over time.

The **beachhead** is the **Operations agent**: it owns back-office tasks like reconciliation, data entry, and status updates, doing them the same careful way every time, with a person one step away. We sell it as a **setup fee plus monthly retainer**.

The **moat** is trust, not model access. Every agent runs inside a guardrail policy gate, logs every action and the reasoning behind it to a full audit trail, and hands off to a human when judgment is needed. "You can see everything it did, and why" is the product, not a feature.

The **runtime core already exists** (agentic loop, policy gate, audit trail, handoff, prompt caching, a reference Support agent). This PRD defines what turns that core into a venture with paying customers.

---

## 2. Problem and opportunity

SMB and mid-market operators pay smart, expensive people to do repetitive work: matching invoices to payments, copying data between systems, chasing statuses, updating records. It is slow, error-prone, and demoralizing, and it does not scale without hiring.

Existing options each fall short:
- **Manual / offshore labor** — ongoing cost, quality drift, management overhead.
- **RPA (UiPath, etc.)** — brittle, breaks on any UI or process change, expensive to maintain, no judgment.
- **Point SaaS tools** — solve one narrow task, do not adapt to how a specific team actually works.
- **Raw LLM chatbots** — answer questions but do not *do* the work, and offer no guardrails or auditability.

The opening: LLM agents are now good enough to do the work end to end, but most teams cannot build, trust, or operate them. Jantra AI is the studio that does it for them, with the trust layer built in.

---

## 3. Vision and strategy

**Vision.** Every company runs its repetitive operations on autonomous agents it can fully trust and audit, with humans focused on judgment and exceptions.

**Strategy — three stages:**

1. **Studio (now → ~12 months).** Done-for-you. We sit with a client, learn one operation, build a custom Ops agent on the shared runtime, run it beside their team, then let it go live. Revenue is setup fee plus retainer. Goal: 5–10 reference customers, a repeatable build playbook, and a runtime hardened by real use.
2. **Productized studio (~12 → 24 months).** The runtime, integrations, approval UI, and audit console become a real product. Builds get faster and cheaper; we templatize the common Ops patterns. Margins rise as build effort drops.
3. **Self-serve platform (24 months+).** Customers (or partners) configure and deploy agents themselves on the platform, with studio services as the premium tier.

The studio stage is deliberate: services revenue funds the product, and every hand-built agent teaches us what to productize. We do not guess at a platform in the dark.

---

## 4. Target market and ICP

**Segment:** SMB and mid-market (roughly 10–2000 employees).

**Ideal customer profile (beachhead):**
- Has a clear, high-volume, rule-heavy back-office process (reconciliation, order ops, data movement, status chasing).
- Currently does it with 1+ FTEs or a stretched ops/finance person.
- Runs on systems with APIs (accounting, CRM, spreadsheets, e-commerce/ERP, email).
- Founder/ops-lead can buy without a 6-month procurement cycle.
- Feels the pain in dollars (labor cost, errors, delays) and can name it.

**Primary buyer:** Head of Operations / Finance, COO, or founder.
**Primary user (day to day):** the ops/finance team member who supervises the agent and handles its handoffs and approvals.

**Out of scope for now:** enterprise (2000+) with long sales cycles and heavy compliance up front. We will grow into it after SOC 2 (§12, §17).

---

## 5. The beachhead: the Operations agent

The first product we sell. It owns a slice of back-office operations end to end: it reads the task, does it in the client's real tools, and pulls in a person only when something genuinely needs a human call.

**Target first use cases (pick one per client to start):**
1. **Reconciliation** — match orders, invoices, and payments across systems; flag mismatches; produce a morning summary. Crisp ROI (hours saved, fewer errors) and high audit value.
2. **Data entry / movement** — move and normalize data between systems (e.g. CRM ↔ spreadsheet ↔ ERP) on a schedule or trigger.
3. **Status updates and exception handling** — keep records and stakeholders current; escalate exceptions.

**Why Operations as the wedge:** stickier and less crowded than support, higher margin, and the audit trail is a genuine differentiator where money and records are involved. Trade-off: each first build is more bespoke, which the studio model absorbs.

> Note: the **Support agent** already built in the runtime stays as the internal reference and sales demo. The first *customer* agent is an Operations agent.

---

## 6. Positioning and differentiation

**Positioning statement.** For SMB and mid-market operators drowning in repetitive back-office work, Jantra AI is the studio that builds and runs autonomous agents to do it, with a guardrail and audit layer that makes the work trustworthy. Unlike RPA (brittle, no judgment) or chatbots (talk, do not act), Jantra AI's agents finish the task and show their work.

**Three pillars (the trust story):**
1. **It acts, it does not just chat.** The agent completes the task in real tools, not a conversation about it.
2. **You can see everything it did.** Every action is logged with the reasoning behind it. No black box.
3. **A human is always one step away.** When judgment is needed, it stops and hands off with full context, inside guardrails you set.

These map directly to runtime capabilities we have already built (audit trail, policy gate, handoff), so the positioning is honest.

---

## 7. Goals and non-goals

**Goals (first 12 months):**
- Land **5–10 paying design-partner clients** on Operations agents.
- Prove the **trust layer** as a real differentiator in sales.
- Reach a **repeatable build playbook** (discovery → live in ≤4 weeks).
- Harden the runtime through real production use.
- Reach **positive unit economics** per engagement (setup + retainer > delivery + run cost).

**Non-goals (for now):**
- A self-serve, no-touch platform (that is stage 3).
- Enterprise compliance (SOC 2, on-prem) before we have references (it is on the roadmap, not the critical path).
- Breadth across many verticals at once. One wedge, done well.
- Building our own models. We build on Claude.

---

## 8. Personas

1. **The buyer — "Priya, Head of Ops."** Owns the pain and the budget. Cares about hours saved, error reduction, and not getting burned by an opaque AI. Needs ROI she can defend and an audit trail she can trust.
2. **The supervisor — "Marco, Ops Analyst."** Works alongside the agent daily. Approves gated actions, handles handoffs, wants the agent to be predictable and easy to correct.
3. **The studio operator — us.** Builds the agent, configures the policy, wires integrations, monitors runs, manages the relationship and expansion.

---

## 9. Product principles

- **Trust over autonomy.** Default to gating and handoff; earn autonomy as confidence grows.
- **Fail closed.** When unsure or unapproved, stop and hand off. Never guess on what matters.
- **Everything is auditable.** If it happened, it is in the log, with the reasoning.
- **One engine, many agents.** Verticals are prompt + tools + policy on the same runtime. Resist forking the core.
- **Real tools, real work.** Value is measured in tasks completed, not messages sent.

---

## 10. Functional requirements

### 10.1 Runtime / core
| # | Requirement | Status |
|---|---|---|
| R1 | Agentic tool-use loop on Claude (latest Opus, adaptive thinking, configurable effort) | ✅ Built |
| R2 | Guardrail policy gate: allow / ask / deny by risk class + deny-list + always-ask | ✅ Built |
| R3 | Append-only audit trail capturing thinking, messages, tool calls, policy decisions, approvals, results, handoffs | ✅ Built |
| R4 | Human handoff + built-in escalate tool; fail-closed approval | ✅ Built |
| R5 | Prompt caching (frozen system prompt, stable tool order) | ✅ Built |
| R6 | **Multi-turn conversations / long-running tasks** (loop is single-turn today) | ❌ To build |
| R7 | **Persistence** — runs, audit, conversation state in a database (currently JSONL files) | ❌ To build |
| R8 | **Scheduling / triggers** — run on cron, webhook, or inbound event (not just manual CLI) | ❌ To build |
| R9 | **Multi-tenancy** — per-client isolation of data, config, and credentials | ❌ To build |
| R10 | **Context management** — compaction / context editing for long agent runs | ❌ To build |
| R11 | **Retry / resumability** — recover a run after a crash without losing the audit trail | ❌ To build |

### 10.2 Operations agent capabilities
| # | Requirement | Status |
|---|---|---|
| O1 | Reconciliation agent: pull records from 2+ systems, match, flag mismatches, summarize | ❌ To build |
| O2 | Data movement agent: read/normalize/write between systems on schedule or trigger | ❌ To build |
| O3 | Status-update / exception-handling agent | ❌ To build |
| O4 | Per-task success criteria / outcome definition so a run has a checkable "done" | ❌ To build |

### 10.3 Integrations (the tool surface)
First-wave connectors needed for the Ops wedge. Build behind the existing tool/MCP surface; prioritize per first client.
| # | Integration | Priority |
|---|---|---|
| I1 | Spreadsheets (Google Sheets / Excel) | MVP |
| I2 | Email (Gmail / Outlook) for ops inboxes and notifications | MVP |
| I3 | Accounting (QuickBooks / Xero) | MVP (reconciliation) |
| I4 | Slack (approvals + handoff channel) | MVP |
| I5 | CRM (HubSpot / Salesforce) | Phase 2 |
| I6 | E-commerce / ERP (Shopify / NetSuite) | Phase 2, client-driven |
| I7 | Generic HTTP / MCP connector for the long tail | Phase 2 |

### 10.4 Approval and handoff experience
| # | Requirement | Status |
|---|---|---|
| A1 | Approve/deny gated actions outside the terminal (Slack first, then web) | ❌ To build |
| A2 | Handoff delivery to a real channel (Slack / ticket / email) with full context | ❌ To build (console stub exists) |
| A3 | Notifications for pending approvals and escalations | ❌ To build |

### 10.5 Audit and observability (customer-facing)
| # | Requirement | Status |
|---|---|---|
| V1 | Customer-readable run history: what the agent did, why, what it touched | ❌ To build (data exists in JSONL) |
| V2 | Per-run usage and cost reporting | Partial (usage captured; no reporting) |
| V3 | Metrics: % automated, handoff rate, approval-decline rate, errors/rework | ❌ To build |
| V4 | Export / retention controls for the audit log | ❌ To build |

### 10.6 Studio / admin console (internal first)
| # | Requirement | Status |
|---|---|---|
| C1 | Define an agent (prompt, tools, policy) per client without code edits | ❌ To build (code-defined today) |
| C2 | Manage client credentials/secrets securely (never in prompts) | ❌ To build |
| C3 | Monitor live runs across clients | ❌ To build |
| C4 | Versioning of agent configs with rollback | ❌ To build |

---

## 11. Non-functional requirements

- **Security:** secrets never in prompts or logs; per-client credential isolation; least-privilege tool access; encrypted at rest and in transit. SSO and a basic security questionnaire answer needed for mid-market.
- **Privacy / data handling:** clear data-processing terms; configurable retention and redaction on the audit log (it can contain customer PII).
- **Reliability:** runs are resumable; no audit entry is ever lost (append-only, synchronous writes today; durable store later).
- **Performance:** time-to-first-action and end-to-end task latency tracked per agent; prompt caching kept warm.
- **Cost:** model spend tracked per run and per client; effort tuned per task; usage allowance built into the retainer so cost is predictable.
- **Compliance (roadmap, not blocking):** SOC 2 Type I then II once we move upmarket. GDPR/CCPA-aware data handling from day one.

---

## 12. Architecture overview

```
        Triggers (cron / webhook / inbound email / manual)
                          │
                          ▼
   ┌─────────────────────────────────────────────┐
   │  Jantra AI Runtime  (one engine, many agents)│
   │  agent loop · policy gate · audit · handoff  │
   └───────┬───────────────┬───────────────┬──────┘
           │               │               │
   Agent config       Tool surface     Audit store
   (prompt+tools+      (integrations    (durable, per-client,
    policy, per        via tools/MCP;   redactable)
    client, versioned) creds host-side)
           │               │
           ▼               ▼
     Approval/Handoff   Client systems
     (Slack → web)      (Sheets, email, accounting, CRM, ERP)
```

- **Hosting / tenancy (decided):** **self-hosted** runtime. Start **single-tenant** (Xolver only). Scope all data by `client_id` from day one so multi-tenancy is a later addition, not a rewrite. Offer per-client isolation only when a client's security requirements demand it.
- **Credentials:** kept host-side, injected at call time; never placed in the model context.
- **Orchestration (decided):** stay on the **self-hosted runtime** for full control of the gating and audit layer. Re-evaluate Claude Managed Agents (hosted loop/sandbox) at Phase 2 only if it accelerates hosting without giving up that control.

---

## 13. Pricing and packaging

**Model:** setup fee + monthly retainer (confirmed).

- **Setup fee (one-time, per agent):** covers discovery, build, integration, and the shadow period. Reflects real build effort; drops over time as we templatize.
- **Monthly retainer (recurring, per agent):** covers running the agent, monitoring, tuning, support, and a model-usage allowance. Overage on usage billed above the allowance.
- **Expansion:** additional agents per client are the primary growth lever (land one operation, expand to the next).

> All price points are TO VALIDATE with the first 3 discovery calls. Structure example (illustrative, not committed): setup in the low-to-mid four figures per agent, retainer in the high-three to low-four figures per month, usage allowance sized to expected task volume. Validate willingness-to-pay against the FTE cost the agent displaces (anchor: a fraction of one loaded FTE salary).

**Evolution:** introduce usage-based and outcome-based options once metering is solid and we have data on per-task value (stage 2+).

---

## 14. Success metrics / KPIs

**Business**
- Number of design-partner and paying clients.
- Setup revenue and MRR; gross margin per engagement.
- Agents per client (expansion) and logo retention.
- Time-to-value: contract signed → agent live.

**Agent / product**
- **% of tasks fully automated** (completed with no human action) — the headline number.
- Handoff rate and approval-decline rate.
- Error / rework rate vs. the prior manual baseline.
- Hours saved per client per week (the ROI story).
- Audit completeness (target: 100% of actions logged with reasoning).

**Trust**
- Incidents (wrong/unauthorized action reaching a client system) — target zero.
- Policy violations caught by the gate (proof the gate works).
- Mean time from escalation to human response.

---

## 15. Delivery model — how an engagement runs

Mirrors the studio "how we work" promise:
1. **Discovery / watch the work** — sit with the team, learn one operation, define checkable success criteria. (≤1 week)
2. **Build the agent** — prompt, tools, policy, integrations, wired to real systems with guardrails. (1–2 weeks)
3. **Run beside the team (shadow)** — agent proposes/acts under approval; the team sees every action before it touches anything real. (1 week)
4. **Go live** — autonomy dialed up as confidence grows; human stays one step away.
5. **Manage and expand** — monitor, tune, report ROI, add the next agent.

Target: discovery → live in **≤4 weeks** for the first agent, faster as the playbook matures.

---

## 16. Roadmap and milestones

Relative phases; calendar start TBD (§18). Each phase ends with a checkable outcome.

- **Phase 0 — Core (done).** Runtime: loop, policy gate, audit, handoff, caching, Support reference agent. ✅
- **Phase 1 — Planning pipeline, dogfooded on Xolver (MVP).** Design partner #1 is Xolver itself, and the chosen process is Xolver's own client-delivery planning: idea → research → planning, built on the runtime as a 3-stage pipeline with a human confirmation gate between stages. **Stage 4 (Build) is deferred** (see scope note and `docs/PIPELINE.md`). Forces real runtime upgrades: multi-turn (R6), persistence (R7), and a confirmation-gate model. Built incrementally (Intake done, then Research, then Planning). **Exit: the pipeline turning a real idea into a researched, fully-planned product (PRD + TRD + build plan) at Xolver, fully audited, usable as the reference demo.**

  > Note: the sellable back-office **Operations agent** wedge (§5) remains the external go-to-market story for SMB/mid-market. The onboarding pipeline is the Xolver dogfood and a demonstration of the runtime's range; it may also become a productized Xolver offering. Wedge decision unchanged for now.
- **Phase 2 — Repeatable studio.** Multi-tenancy (R9), credential vault (C2), internal console to define/monitor agents (C1, C3), customer-readable run history (V1, V3), 2–3 more clients, build playbook documented. **Exit: ≤4-week build, 3–5 paying clients.**
- **Phase 3 — Productize.** Config-driven agents with versioning/rollback (C4), templated Ops patterns, self-serve onboarding for common cases, pricing v2 (usage/outcome options), SOC 2 Type I kickoff. **Exit: build effort halved; first self-serve-ish customer.**
- **Phase 4 — Platform.** Customer/partner-configurable agents, marketplace of Ops templates, upmarket motion. 

---

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **An agent takes a wrong/costly action in a client system** | Policy gate + fail-closed approvals on every write/sensitive action; shadow period before go-live; full audit for fast diagnosis. |
| **Trust barrier — buyers fear opaque AI on money/records** | Lead with the audit trail and handoff as the product; offer a shadow/pilot; show the log. |
| **Bespoke builds do not scale (services trap)** | Treat every build as productization input; templatize aggressively in Phase 2–3; track build hours as a falling metric. |
| **Model cost erodes margin** | Usage allowance in retainer; effort tuning; prompt caching; monitor cost per task. |
| **Integration brittleness** | Prefer API/MCP integrations over UI automation; generic HTTP/MCP connector for the long tail. |
| **"Jantra AI" name / trademark conflict** | Trademark + domain search before any public launch (§18). |
| **Sales cycle longer than studio cash runway** | SMB-first for fast cycles; setup fee improves cash flow; keep delivery lean. |

---

## 18. Decisions (finalized 2026-06-02) and what remains

**Finalized:**
1. **Delivery model:** studio-led, productize later.
2. **Wedge:** Operations agent.
3. **Customers:** SMB + mid-market.
4. **Pricing:** setup fee + monthly retainer (figures validated in discovery).
5. **Timeline:** no fixed calendar. Capacity- and AI-tooling-driven. First milestone is **one working Operations agent in production**.
6. **First design partner:** **Xolver itself.** We dogfood the first agent on Xolver's own operations, then use it as the reference case for outside clients.
7. **Orchestration:** **self-hosted runtime** (full control of the gating/audit layer). Re-evaluate Managed Agents at Phase 2.
8. **Hosting / tenancy:** **single-tenant now** (Xolver only); data model `client_id`-scoped so multi-tenancy is a later feature, not a rewrite. Per-client isolation offered when a client's security requires it.
9. **First Xolver process:** the client-delivery **planning pipeline** (Intake → Research → Planning). See `docs/PIPELINE.md`.
10. **Pipeline scope:** three stages only — Intake → Research → Planning. **Stage 4 (Build) deferred** (most expensive + least reliable; revisit after the planning product is proven). Keeps cost per idea predictable — roughly $0.35–$2.50 depending on model choice, vs. $10–80+ once a real build is included.

11. **Name (decided):** **Jantra AI** — from *jantra/yantra* (machine/instrument); reads as "machine AI". GitHub: `DecoyINDIA/AI_Jantra`. A trademark + domain check is still worth doing before public launch, but the name is set.

12. **Models (decided): Gemini 2.5 only — no Claude/Opus in the runtime.** Each stage is selectable between **Gemini 2.5 Flash** (cheap) and **Gemini 2.5 Pro** (higher quality) via config. Recommended defaults: Intake = Flash, Research = Flash (with Google Search grounding), Planning = Pro. Can be set to all-Flash (~$0.10–0.25/idea), the recommended mix (~$0.40–0.90/idea), or all-Pro (~$1–3/idea). The model layer uses Google's `@google/genai` SDK and a `GEMINI_API_KEY`. Gemini equivalents replace Claude features: thinking config (audit reasoning), context caching (cost), Search grounding (Research). Exact model IDs / SDK details to be verified against Google docs at build time. (Code still defaults to Claude until the Gemini layer is built.)

**Remaining:**
1. **Pricing numbers** — validate in the first external discovery calls.

---

## 19. Appendix — current build status

See `README.md`. Summary: the runtime **core is built and typecheck-clean** (loop, policy gate, audit, handoff, caching, Support reference agent, runnable CLI). Not yet built: multi-turn, persistence, scheduling, multi-tenancy, real integrations, approval/handoff UI, customer-facing audit views, tests. The next concrete build is **Phase 1** above.

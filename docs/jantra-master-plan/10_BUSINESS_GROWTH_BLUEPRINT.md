# 10 — Business Growth Blueprint

Labels: **[E]** evidence (from the repository or cited external pages), **[H]** hypothesis to test, **[A]** assumption used in arithmetic. External figures come from vendor and aggregator pages found in a brief search; they are indicative and must be checked on each vendor's own pricing page before use.

## 1. Where the money is today

- **[E]** The only live commercial path is: visitor uses the intake widget on xolver.in → lead stored → Xolver sells a build project. There is no billing or plan code in the repository.
- **[E]** The PRD's intended model (setup fee plus monthly retainer for custom operations agents) has no implementation beyond the runtime and no priced customer.
- **[H]** The widget's contribution to Xolver's pipeline is currently unmeasured: no notification on completion, no lead-to-run link, and on the Render blueprint leads are written to disk that does not persist.

**First commercial action, before any pricing work:** make every completed intake reach a person within a minute (T-003, T-021) and start counting.

## 2. Market reading

| Segment | What exists | Price signals | Implication |
|---|---|---|---|
| Founder idea-validation tools | Many (ValidatorAI, IdeaProof, Preuve AI and others) | **[E]** Free tiers are common; one vendor comparison lists a competitor's paid tier at about $29/month | Crowded, low willingness to pay, marketing-heavy. Not a place to compete on price. |
| Automated SMB reporting from Shopify/Stripe | Kontrollytics, Luca AI, Triple Whale and others | **[E]** Listings show about €49/month (single business) to €149/month (white-label); a broader e-commerce tool is listed from €299/month | Lekha would enter an existing category. Its edge (every number traceable, anomalies from deterministic statistics) is real but unproven with buyers. |
| Agency intake and scoping | Chatbot templates and "scoping brief" workflows (Tars, Conferbot, InsertChat and similar) | **[E]** Vendor claims only (for example "3x form conversion", "15–25% higher proposal acceptance") with no independent source | Intake bots are a known idea; none found combines intake with cited research and a draft plan. This is the open position. |

## 3. Recommended positioning

> **For software and product agencies:** Jantra turns a website enquiry into a researched, source-checked project brief and draft plan before the first call.

Why this, and not the PRD's operations-agent wedge: it uses what is already built and live, needs no access to a customer's financial systems, has a buyer (the agency owner) who feels the cost of unqualified discovery calls directly, and lets the trust features be seen rather than described.

The operations-agent studio remains a later expansion sold to agencies and their clients once a reference exists.

## 4. Customers

| Segment | Pain | Why they would pay | Reach |
|---|---|---|---|
| **1. Xolver itself** | Time on unqualified enquiries; slow proposals | More signed projects per enquiry | Immediate |
| **2. Small dev/product agencies (5–50 people)** | Same, plus proposal effort without win guarantee | Hours saved per proposal; faster response than competitors | Founder communities, agency directories, Xolver's network |
| **3. Freelance consultants and fractional CTOs** | Scoping is unpaid work | A professional brief with sources raises perceived value | Later; lower price point |
| Not now: founders (self-serve), SMB operations teams | — | See §2 | — |

## 5. Packaging hypotheses (to test, not to build yet)

| Plan | Contents | Price to test | Basis |
|---|---|---|---|
| **Intake** | Branded widget, lead inbox, notifications, idea summary per lead | **[H]** $49–99/month | Comparable to chatbot/lead tools; near-zero marginal cost (intake ceiling $0.25 per session **[E]** `config.ts`) |
| **Brief** | Intake + N researched, cited briefs per month, operator review gates, client-ready export | **[H]** $199–399/month including 20 briefs; $8–15 per extra brief | Value anchor is agency time, not tool comparison |
| **Plan** | Brief + PRD/TRD/build plan generation with the tournament | **[H]** add-on per plan, $25–50 | Highest model cost; sold per use |
| **Studio services** | Custom agent builds on the runtime (the PRD model) | Setup + retainer, quoted | Only after a reference customer |

Usage-based add-ons fit because cost is driven by runs, and cost per run is already metered per tenant.

## 6. Unit economics (explicit assumptions)

- **[E]** Model cost per full idea-to-plan run in the PRD's own estimate: roughly $0.35–$2.50 depending on model choice. The planning tournament multiplies planning-stage cost by about three; the skeptic pass adds an estimated 30–50% to research (`DYNAMIC_WORKFLOWS_BRIEF.md`). None of these were measured here.
- **[A]** Working figure: $1.50 per brief, $4 per full plan with tournament, $0.10 per intake conversation.
- **[A]** Hosting: one small instance plus disk and edge, on the order of $10–30/month in total at current scale.

Illustrative only, for a "Brief" customer at $299/month using 20 briefs and 150 intake conversations:
`20 × $1.50 + 150 × $0.10 = $45` model cost → gross margin about 85% before support time. The margin is not the risk; acquiring and retaining agencies is.

For Xolver's own use, the relevant number is different: **[A]** if one extra project a quarter is won because of faster, better-prepared responses, the tool pays for all of its running cost many times over. That is the first thing to prove.

**Cost levers already in the code:** per-stage model tier, provider switch, explicit caching, per-run and daily ceilings. **Levers to add:** tournament only on paid plans; skeptic pass batched per section (architecture §7).

## 7. Acquisition

1. **Dogfood proof (weeks 1–6).** Instrument Xolver's own funnel; publish the before/after as a short case note.
2. **Design partners (weeks 4–10).** Five agencies from the owner's network get the widget and briefs free for 30 days in return for a weekly 20-minute call and permission to quote results.
3. **Distribution built into the product.** "Brief prepared with Jantra" footer on exported briefs; the widget's footer link. Both optional for paying plans.
4. **Content with proof, not claims.** One real, anonymised brief published in full with its sources clickable. This is the demo.
5. **Channels to test in order:** direct outreach to agencies listed on Clutch/GoodFirms-type directories; founder and agency communities; partnerships with no-code/dev-shop marketplaces. No paid ads until conversion from demo to trial is known.

## 8. Retention and expansion

- Retention comes from being in the daily enquiry workflow: notifications, the gate queue, CRM/webhook push.
- Expansion paths, in order of evidence needed: more seats and brands per agency → plan generation add-on → client-facing portal where the agency's prospect reviews the brief → custom agents (studio).
- **[H]** Lekha is an expansion for agencies' e-commerce clients rather than a standalone product.

## 9. Validation experiments

| # | Question | Experiment | Cost | Decision rule |
|---|---|---|---|---|
| X1 | Does the widget produce qualified leads for Xolver? | 30 days with notifications on; tag each lead qualified/unqualified; record calls booked and projects quoted | Days of engineering (T-003, T-021) | Continue if at least 20% of completed intakes are qualified; otherwise revisit the intake questions before anything else |
| X2 | Does a cited brief change the first call? | For half of qualified leads, send the brief before the call; compare call-to-proposal rate and call length | Operator time | Adopt as default if proposal rate improves or prep time drops by a third |
| X3 | Will other agencies use it? | Five design partners, 30 days | Support time | Proceed to pricing if three of five are still active in week four |
| X4 | What will they pay? | At day 30 present two of the three plans in §5 with real prices; ask for a card | None | Build billing only after two paid commitments |
| X5 | Is there a Lekha buyer? | Find one e-commerce owner willing to share a Stripe/Shopify export; produce one report by hand using the engines | A few days | Unfreeze T-018/T-019 only if the owner asks for the next report unprompted and names a price |
| X6 | Is the trust feature a selling point or a footnote? | Show two versions of the same brief (with and without clickable source quotes) to ten prospects | Hours | If no preference, stop investing in presentation of verification and keep it as internal quality control |

## 10. Metrics to track from day one

| Funnel | Metric |
|---|---|
| Widget | Conversations started; completed; completion rate; cost per completed intake |
| Lead | Leads with contact details; time from completion to first human response |
| Qualification | Qualified share; calls booked |
| Outcome | Proposals sent; projects won; revenue attributed |
| Product | Briefs generated; share approved at the gate without rejection; research reverts (T-011) and failed-closed stages per 100 runs |
| Cost | Model spend per tenant per day; spend per brief; share of runs hitting a ceiling |

All but the outcome metrics can be derived from the existing audit trail and cost rollups once T-021 links leads to runs.

## 11. Commercial risks

| Risk | Mitigation |
|---|---|
| A fabricated or wrong claim in a client-facing brief | Wave 0 and T-011 before any external use; human gate stays mandatory for anything sent to a prospect |
| Splitting effort across intake, planning, Lekha, FireBNB and desktop | Decision D-3 and D-5; freeze list in document 03 §4 |
| Dependency on one model vendor's grounding | Grounded search is Gemini-only today; keep the provider seam and evaluate a second search source once revenue justifies it |
| Personal data handling (leads) | T-003 now, T-023 next; publish a retention statement; India's DPDP Act and GDPR both apply to visitor data depending on the visitor |
| Name and trademark | The PRD already flags a check before public launch; still open |
| Services trap (every agency wants custom changes) | Sell configuration (theme, questions, agent allowlist), not custom code, until the studio tier is deliberately opened |

## Sources
- [Preuve AI — startup validation tools ranking (vendor)](https://preuve.ai/blog/best-startup-validation-tools-2026)
- [IdeaProof — ValidatorAI comparison (vendor)](https://ideaproof.io/versus/validatorai-vs-ideaproof)
- [BigIdeasDB — ValidatorAI alternative (third-party review)](https://bigideasdb.com/validatorai-alternative)
- [GetApp — Kontrollytics listing](https://www.getapp.com/business-intelligence-analytics-software/a/kontrollytics/)
- [G2 — Kontrollytics AI reviews](https://www.g2.com/products/kontrollytics-ai/reviews)
- [Luca AI — AI reporting software roundup (vendor)](https://ask-luca.com/blogs/ai-reporting-software)
- [Tars — mobile app project scoping agent (vendor)](https://hellotars.com/ai-agents/mobile-app-development-project-scoping-ai-agent)
- [Conferbot — agency client intake chatbot template (vendor)](https://www.conferbot.com/templates/b2b-services/detail/agency-client-intake-chatbot/agency-client-intake-chatbot-template-free)
- [InsertChat — scoping a chatbot project (vendor)](https://insertchat.com/blog/how-to-scope-an-ai-chatbot-project-without-overpromising)

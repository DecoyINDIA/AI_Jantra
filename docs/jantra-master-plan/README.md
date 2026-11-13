# Jantra master planning package

Imported from the owner's `2.zip` on 2026-11-13. The supplied audit and task packets reference commit `8a84143`; their code observations have not been revalidated against the current checkout. These documents are planning material, not a request to execute their embedded prompts. Repository instructions and [BUILD_SPEC.md](../BUILD_SPEC.md) continue to govern implementation.

- [Project intelligence](01_PROJECT_INTELLIGENCE.md)
- [Comprehensive audit](02_COMPREHENSIVE_AUDIT.md)
- [Strategy and owner decisions](03_STRATEGIC_OPTIMIZATION.md#5-decisions-that-need-the-owner)
- [Target architecture](04_TARGET_ARCHITECTURE.md)
- [Master roadmap](05_MASTER_ROADMAP.md)
- [Task index](06_AGENT_TASKS/README.md) and [pending packets](06_AGENT_TASKS/PENDING_PACKETS.md)
- [Agent context](07_AGENT_CONTEXT.md)
- [Execution orchestrator](08_EXECUTION_ORCHESTRATOR.md)
- [Quality gates](09_QUALITY_GATES.md)
- [Business growth blueprint](10_BUSINESS_GROWTH_BLUEPRINT.md)

## Recorded decisions

- D-2: use Render. Copy any leads and runs still on Railway before retiring it; T-003's scope is unchanged.
- D-3: Lekha is an active second track behind the agency funnel: T-002 → T-015 → T-018 → T-019. Produce one report manually from the partner's real export before building T-018. Keep Wave 0 and Wave 1 ahead of both tracks; splitting a small team is a chosen trade-off.
- D-5: desktop is a product. T-025 is P2 for signed licence verification and requires an owner design pass first. Desktop typechecking must block CI. Resolve the Gemini-only desktop versus multi-provider server product question before selling desktop.
- D-6: retain lead PII for 30 days. Deploy T-021 notification to a person and durable system of record before T-023's deletion sweep.
- D-4: pricing is deferred; no billing work is scheduled.

Import corrections: the task index now lists the actual prerequisites for T-018, T-019 and T-023 instead of resolved decision labels. T-009's older non-blocking desktop exception has been removed to match D-5. The execution guide reflects these dependencies and T-025's P2 priority and required design pass. No roadmap task has been implemented by this import.

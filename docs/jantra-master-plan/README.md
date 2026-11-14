# Jantra master planning package

Imported from the owner's `2.zip` on 2026-11-13. Documents 01-10 retain the original audit, design, and execution context at `8a84143`; they are historical planning material, not current implementation evidence or instructions to rerun completed work. Repository instructions and [BUILD_SPEC.md](../BUILD_SPEC.md) continue to govern implementation.

Current status: F-001 through F-007 are committed and pushed through `d77df95`; local gates pass. Retention correctness follow-up and external acceptance remain open. Read the validation document before assigning further work.

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
- [Execution progress](PROGRESS.md)
- [Completed execution brief](11_FINAL_COMPLETION_BRIEF.md)
- [Current validation and follow-up](12_VALIDATION_AND_FOLLOW_UP.md)

## Recorded decisions

- D-2: use Render. Copy any leads and runs still on Railway before retiring it; T-003's scope is unchanged.
- D-3: Lekha is an active second track behind the agency funnel: T-002 → T-015 → T-018 → T-019. Produce one report manually from the partner's real export before building T-018. Keep Wave 0 and Wave 1 ahead of both tracks; splitting a small team is a chosen trade-off.
- D-5: desktop is a product. The owner selected offline signed licences, read-only unlicensed access, and multi-provider desktop support. These are implemented; packaged desktop acceptance remains pending. Desktop typechecking blocks CI.
- D-6: retain lead PII for 30 days. Deploy T-021 notification to a person and durable system of record before T-023's deletion sweep.
- D-4: pricing is deferred; no billing work is scheduled.

The original import did not implement tasks. Subsequent implementation and corrections are recorded in PROGRESS.md and the validation document. Signed webhook delivery was selected by the owner; billing remains deferred.

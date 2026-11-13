# Jantra Master Plan — Execution Progress Record

Initialized: 2026-11-13
Status: In Progress

## Recorded Owner Decisions Applied
- **D-1**: Default public agent allowlist: `intake-public` (and route restriction).
- **D-2**: Render deployment target. Copy any leads and runs still on Railway before retiring Railway. T-003 scope unchanged.
- **D-3**: Lekha is active second track behind agency funnel: T-002 → T-015 → T-018 → T-019. Produce report manually from partner export before T-018. Waves 0 & 1 ahead of both tracks.
- **D-4**: Pricing deferred; no billing work scheduled.
- **D-5**: Desktop is a product. T-025 is P2 and requires licensing design pass with owner. Desktop typechecking blocks CI.
- **D-6**: 30-day retention. T-021 must be deployed and delivering leads to a person and durable system before T-023 deletion sweep.

---

## Task Execution Log

| Task | Priority | Status | Commit | Verified Push | Checks Run | Notes |
|---|---|---|---|---|---|---|
| **T-003** | P0 | Completed | pending | pending | G1 (46/46 eval, typecheck, smoke, server:smoke) | Single data root on persistent disk |
| **T-002** | P0 | Pending | - | - | - | Ops pipeline honesty |
| **T-001** | P0 | Pending | - | - | - | Restrict public API keys |
| **T-004** | P0 | Pending | - | - | - | Outbound request guard (safeFetch) |
| **T-005** | P1 | Pending | - | - | - | Discovery: origin client address |
| **T-007** | P1 | Pending | - | - | - | Clean error envelope |
| **T-008** | P1 | Pending | - | - | - | Store defects |
| **T-009** | P1 | Pending | - | - | - | Cross-platform scripts & CI typecheck |
| **T-010** | P1 | Pending | - | - | - | Persist research checkpoints |
| **T-006** | P1 | Pending | - | - | - | Per-visitor limits |
| **T-011** | P1 | Pending | - | - | - | Verify research report after refinement |
| **T-012** | P1 | Pending | - | - | - | Budget reserve/settle & unknown price guard |
| **T-013** | P1 | Pending | - | - | - | Documentation truth pass |
| **T-016** | P2 | Pending | - | - | - | Production container |
| **T-017** | P2 | Pending | - | - | - | Unit tests & split regressions |
| **T-021** | P2 | Pending | - | - | - | Lead notification & lead<->run link |
| **T-020** | P2 | Pending | - | - | - | Promote intake to plan & gate queue UI |
| **T-022** | P2 | Pending | - | - | - | Client-ready export |
| **T-015** | P2 | Pending | - | - | - | One SQLite database with migrations |
| **T-014** | P2 | Pending | - | - | - | Asynchronous stage execution |
| **T-018** | P2 | Pending | - | - | - | Per-client connector credentials |
| **T-019** | P2 | Pending | - | - | - | Real report delivery |
| **T-023** | P2 | Pending | - | - | - | Lead retention & deletion |
| **T-025** | P2 | Blocked | - | - | - | Requires licensing design pass with owner |
| **T-024** | P3 | Pending | - | - | - | Operator UI token handling |
| **T-026** | P3 | Pending | - | - | - | Model catalog from configuration |

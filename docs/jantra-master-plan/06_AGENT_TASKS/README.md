# 06 — Agent Task Packets

## How to use a packet
1. Give the agent `07_AGENT_CONTEXT.md` plus exactly one packet file.
2. Each packet has a short header (for the orchestrator) and one **Standalone Execution Prompt**. The prompt carries every required field — context, files, instructions, contracts, edge cases, non-goals, acceptance, verification, rollback, escalation — so nothing is stated twice and the agent needs nothing else.
3. The agent must end with the report format defined in the context package.

This index preserves the original packet scope at `8a84143`. Implementation has since occurred. Consult [current validation](../12_VALIDATION_AND_FOLLOW_UP.md) and [progress](../PROGRESS.md) before assigning work; do not rerun completed packets. The original planning pass did not run verification commands; later validation did.

## Index

| Task | Title | Priority | Tier | Effort | Prereqs | Packet |
|---|---|---|---|---|---|---|
| T-001 | Restrict public API keys | P0 | Medium | M | — | full |
| T-002 | Ops pipeline: no silent synthetic data, honest receipt | P0 | Small | S | — | full |
| T-003 | Single data root on the persistent disk | P0 | Small | S | — | full |
| T-004 | Outbound request guard (`safeFetch`) | P0 | Advanced | M–L | — | full |
| T-005 | Discovery: what address does the origin see? | P1 | Small | S | — | full |
| T-006 | Per-visitor rate limit and intake budget | P1 | Medium | M | T-001, T-005 | full |
| T-007 | Clean error envelope | P1 | Small | S | — | full |
| T-008 | Store defects: webhook file, path safety | P1 | Small | S | — | full |
| T-009 | Cross-platform npm scripts, desktop typecheck in CI | P1 | Small | S | — | full |
| T-010 | Persist research checkpoints | P1 | Small | S | — | full |
| T-011 | Verify the research report after refinement | P1 | Advanced | M | — | full |
| T-012 | Budget reserve/settle and unknown-price guard | P1 | Medium | M | — | full |
| T-013 | Documentation truth pass | P1 | Small | S | T-009 | full |
| T-014 | Asynchronous stage execution | P2 | Advanced | L | T-010 | outline |
| T-015 | One SQLite database with migrations | P2 | Advanced | L | T-003, T-008 | outline |
| T-016 | Production container | P2 | Small | S | T-009 | outline |
| T-017 | Unit tests with `node:test`; split regressions | P2 | Medium | M | T-009 | outline |
| T-018 | Per-client connector credentials | P2 | Advanced | L | T-015; partner export report (X5) before build | outline |
| T-019 | Real report delivery | P2 | Medium | M | T-002, T-018 | outline |
| T-020 | Promote intake to plan; gate queue UI | P2 | Advanced | L | T-021 | outline |
| T-021 | Lead notification and lead↔run link | P2 | Medium | M | T-001, T-003 | outline |
| T-022 | Client-ready export | P2 | Medium | M | T-020 | outline |
| T-023 | Lead retention and deletion | P2 | Medium | M | T-015; T-021 deployed first | outline |
| T-024 | Operator UI token handling | P3 | Small | S | — | outline |
| T-025 | Real desktop licence verification | P2 | Advanced | M–L | design pass | outline |
| T-026 | Model catalog from configuration | P3 | Small | S | — | outline |

"Outline" denotes the original packet format. `PENDING_PACKETS.md` now records implementation status, including external acceptance blockers, rather than a queue of wholly unimplemented tasks.

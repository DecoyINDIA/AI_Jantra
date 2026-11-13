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
| **T-003** | P0 | Completed | d0b561f | Yes | G1 (46/46 eval, typecheck, smoke, server:smoke) | Single data root on persistent disk |
| **T-002** | P0 | Completed | 0736780 | Yes | G1 (48/48 eval, typecheck, smoke, server:smoke) | Ops pipeline honesty |
| **T-001** | P0 | Completed | 1644996 | Yes | G1 (49/49 eval, typecheck, smoke, server:smoke) | Restrict public API keys |
| **T-004** | P0 | Completed | 40120cb | Yes | G1 (50/50 eval, typecheck, smoke, server:smoke) | Outbound request guard (safeFetch) |
| **T-005** | P1 | Completed | - | Read-only | Discovery (Worker/Origin header flow) | Discovery: origin client address (see report below) |

### T-005 Discovery Findings
- **Header Analysis:**
  | Header Name | Value Seen Locally | Value Seen Deployed | Client-Controllable? |
  |---|---|---|---|
  | `X-Forwarded-For` | `203.0.113.9` (forwarded as-is) | Not available | Yes (passed through by Worker) |
  | `X-Jantra-Client-IP` | `203.0.113.9` (forwarded as-is) | Not available | Yes (passed through by Worker) |
  | `CF-Connecting-IP` | `198.51.100.42` | Cloudflare edge IP | No (set by Cloudflare edge) |
- **Answer A:** Is `request.ip` at the origin the visitor's address? **No.** Fastify's `trustProxy: 1` trusts only the immediate reverse-proxy hop (Render proxy). In production, Render's proxy connects to the container socket, resolving `request.ip` to Cloudflare's egress IP; thus, all public edge visitors would share a single IP bucket.
- **Answer B:** Can a browser client inject `X-Jantra-Client-IP` through the current Worker? **Yes.** `worker.js` creates `new Headers(request.headers)` and deletes only `Origin` and `Cookie`, forwarding any client-supplied `X-Jantra-Client-IP` directly to the origin.
- **Recommendation:** **CONFIRM** the T-006 design. `worker.js` must delete incoming `X-Jantra-Client-IP` and set it from `request.headers.get("CF-Connecting-IP")`. The origin must trust `X-Jantra-Client-IP` only when authenticated with `public` key scope.
| **T-007** | P1 | Completed | 0107546 | Yes | G1 (51/51 eval, typecheck, smoke, server:smoke) | Clean error envelope |
| **T-008** | P1 | Completed | 0f8fc48 | Yes | G1 (53/53 eval, typecheck, smoke, server:smoke) | Store defects |
| **T-009** | P1 | Completed | 1c8a17a | Yes | G1 (53/53 eval, typecheck, smoke, server:smoke) | Cross-platform scripts & CI typecheck |
| **T-010** | P1 | Completed | a233bb5 | Yes | G1 (54/54 eval, typecheck, smoke, server:smoke) | Persist research checkpoints |
| **T-006** | P1 | Completed | 16636c8 | Yes | G1 (57/57 eval, typecheck, smoke, server:smoke) | Per-visitor limits |
| **T-011** | P1 | Completed | cfcf245 | Yes | G1 (59/59 eval, typecheck, smoke, server:smoke) | Verify research report after refinement |
| **T-012** | P1 | Completed | 6ed82c6 | Yes | G1 (61/61 eval, typecheck, smoke, server:smoke) | Budget reserve/settle & unknown price guard |
| **T-013** | P1 | Completed | 5f9e017 | Yes | G1 (61/61 eval, typecheck, smoke, server:smoke) | Documentation truth pass |
| **T-016** | P2 | Completed | pending | Yes | G1 + Docker smoke (/health 200, healthy) | Production container |
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

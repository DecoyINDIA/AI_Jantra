# Review of KEYCONSOLE_PLAN.md — approved to build, with changes

> Paste the block below to Codex. The plan is approved. Apply the must-fix and the three answers below, then implement in the plan's stated order.

---

KEYCONSOLE_PLAN.md is approved to build. The precedence model, hash-at-rest, show-once, admin-off-the-public-edge, and the shared single `SqliteProjectStore` instance are all correct. Apply the following before/while building.

## Must-fix
1. **`last_used_at` touch must be best-effort, never fail auth.** The plan (Auth Changes) says to fail closed if the `last_used_at` write fails. That is wrong: revocation is enforced by reading `revoked_at` (validation step 5), not by `last_used_at`. `last_used_at` is observability only. Failing authentication because a metadata UPDATE hit transient SQLite write contention turns a non-issue into an outage and adds zero security. **Change it:** once a valid, non-revoked key is found, return the `Identity`; wrap the `last_used_at` touch in try/catch, log on failure, and continue. Auth success must not depend on the touch succeeding.
2. **Throttle `last_used_at` writes from v1, not "later".** SQLite is a single writer, and the intake flow already writes on every step (saveProject + audit). Touching `last_used_at` on every request adds a write per call and risks contention under concurrent visitors. Only update `last_used_at` when the stored value is null or older than ~60s. Cheap, and it keeps revocation correctness intact (revocation does not depend on the touch).

## Answers to your open questions
1. **`admin.jantra.in` in v1? No — v1 is private/local origin access only.** You are a solo operator pre-launch; do not stand up a public admin hostname yet (it is more infra and another attack surface). Register `/v1/admin/*` on the origin, reach it privately: point the existing web/desktop console at the origin over the host's private networking or an SSH/`fly proxy`-style tunnel to localhost. Add `admin.jantra.in` behind Cloudflare Access only later, when reaching the origin privately becomes a real friction. Keep the plan's design so that path slots in without rework.
2. **Missing `JANTRA_ADMIN_TOKEN`: do not register the routes at all.** Prefer non-registration over a 503 disabled error: smallest attack surface, and an unknown path 404s like anything else, leaking nothing about the feature. The console should treat a 404 on the admin API as "admin not enabled on this origin" and say so. Never fall back to issued keys or the loopback token for admin actions.
3. **`x-jantra-admin-token` is acceptable.** A distinct header for the admin/management plane (separate from the developer `Authorization: Bearer`) is the right call — it avoids any ambiguity with the developer-key auth hook that also reads `Authorization`. Keep it.

## Smaller refinements (apply, low effort)
- **Keep SHA-256 for the key hash; do NOT switch to bcrypt/argon2.** A reviewer may instinctively flag "SHA-256 is weak for secrets" — that rule is for low-entropy passwords. These are 256-bit random tokens, so a fast deterministic hash is both correct and required (you look up by hash; a salted KDF is non-deterministic and cannot be looked up). Add a one-line code comment saying exactly this so it is not "hardened" into breakage later.
- **Generate `JANTRA_ADMIN_TOKEN` with real entropy** (>= 32 bytes via `node:crypto`), same as developer keys. Document this next to the env var.
- **Admin token in the browser:** storing it in localStorage is XSS-exposed. Acceptable for an operator-only console in v1, but prefer injection via `window.JANTRA_DESKTOP` in the desktop app, and note the localStorage caveat in the Settings UI.
- **`edge:verify`:** add an explicit assertion that `POST /v1/admin/keys` and `GET /v1/admin/keys` are blocked (non-200) through the public edge. The Worker's positive allowlist already blocks them, but make the test prove it so a future Worker edit cannot silently expose them.
- **Synthetic audit run id:** using `admin` as the audit stream id for key events is fine (real run ids are UUIDs, no collision). Keep key events out of any tenant-visible run audit.

## Then
Implement in the plan's "Implementation Order After Approval". Keep `typecheck` and `edge:verify` green. When done, summarize what changed and paste: an auth test showing a revoked DB key is rejected while a valid one resolves, the `edge:verify` admin-blocked assertion, and confirmation that a failed `last_used_at` touch does not reject auth.

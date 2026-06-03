# Codex kickoff — Jantra API key console (DB-backed key issuance, list, revoke)

> Paste the block below to Codex. This is a substantial feature (auth model + DB + console UI), so it is plan-first: Codex investigates and writes a plan to `docs/`, and builds only after the plan is approved.

---

You are Codex, the coding agent for **Jantra AI**. Build a **developer API key console**: an operator opens the Jantra console, clicks "Create key", gets a key once to hand to a developer, and can revoke it later — the Stripe/OpenAI experience. This replaces hand-editing `JANTRA_REMOTE_API_KEYS`. **Plan first; do not change code until the plan is approved.**

## Scope: operator console v1 (not public self-serve)
The operator (you) mints keys in Jantra's own console and hands them out. This is NOT a public signup site where external developers create their own accounts and keys — that needs a full public auth system and is a later phase. Build the operator-gated version. In your plan, note clearly where public self-serve would later plug in, but do not build it.

## What exists (use it, do not reinvent)
- **Store:** `src/pipeline/store/sqlite.ts` (`SqliteProjectStore`) opens one `jantra.sqlite` and uses `create table if not exists`. Add the keys table the same way, on the same DB, behind the `ProjectStore`/store layer (or a sibling store sharing the connection).
- **Auth today:** `src/server/auth/apiKeys.ts` — `parseApiKeyRecords()` reads env `JANTRA_REMOTE_API_KEYS` as `key:clientId:subject`; `resolveApiKeyIdentity()` matches the bearer token in constant time and yields an `Identity { subject, clientId, mode }` (`src/server/tenancy.ts`). `timingSafeStringEqual` is in `src/server/constantTime.ts`.
- **Console UI:** `@jantra/web` (`web/src/`) is the existing React + react-query operator console with routes `RunList`, `AgentCatalog`, `RunDetail`, `Settings` (`web/src/routes/`), an API client (`web/src/api/client.ts`), and the `desktop/` Electron wrapper. Add the "API Keys" page here; do not start a new app.
- **Public edge:** `deploy/cloudflare-worker/worker.js` whitelists only the five intake paths, so any `/v1/admin/*` route is already unreachable from the public internet. Keep it that way.

## Step 1 — Read
1. `AGENTS.md`, `docs/BUILD_SPEC.md` — binding rules, auth/tenancy/audit model.
2. `src/server/auth/apiKeys.ts`, `src/server/app.ts`, `src/server/security.ts`, `src/server/tenancy.ts` — the two auth modes (remote API-key, local loopback) and how identity/clientId flow.
3. `src/pipeline/store/sqlite.ts`, `src/pipeline/store.ts` — the store pattern.
4. `web/src/app/App.tsx`, `web/src/routes/Settings.tsx`, `web/src/api/client.ts` — the console shell to extend.

## Step 2 — Design decisions to resolve in the plan (do not guess)
1. **Where the admin routes live.** Key management must write to the SAME DB the remote origin validates against. So `/v1/admin/keys` belongs on the origin. Decide and justify the operator-access path: a separate authenticated admin hostname/Worker route (e.g. `admin.jantra.in`) vs. direct/private-network access to the origin. The public intake edge must never expose admin routes.
2. **Admin auth boundary.** Gate the admin routes with a dedicated `JANTRA_ADMIN_TOKEN` (env, constant-time compared), separate from issued API keys and from the loopback token. Note how the console is configured with it.
3. **Key format + storage.** Decide a readable prefixed format (e.g. `jntr_<base64url>`), store only a **hash** (sha-256) plus a short non-secret display prefix and metadata; the raw key is shown exactly once at creation, never persisted, never logged, never audited.
4. **Validation path.** `resolveApiKeyIdentity` must check the DB (hash lookup, reject if `revoked_at` set) AND keep env `JANTRA_REMOTE_API_KEYS` working as a bootstrap, so nothing breaks and there is always an out-of-band way in. Decide precedence and caching (revoke must take effect promptly).

## Step 3 — Write the plan to `docs/KEYCONSOLE_PLAN.md`
Include:
1. **DB schema** — `api_keys` table: id, key_hash, prefix, client_id, subject, label, created_at, last_used_at (nullable), revoked_at (nullable). Migration via `create table if not exists`.
2. **Store methods** — create / get-by-hash / list (metadata only) / revoke / touch-last-used.
3. **Auth change** — DB-backed `resolveApiKeyIdentity` with env fallback; constant-time; revoke honored on next request.
4. **Admin API** — `POST /v1/admin/keys` (body: label, clientId, subject -> returns the full key ONCE + metadata), `GET /v1/admin/keys` (metadata list, never the key/hash), `POST /v1/admin/keys/:id/revoke`. All behind the admin-token guard, registered only where the operator can reach them, never on the public edge.
5. **Console page** — an "API Keys" route in `@jantra/web`: list (label, prefix, created, last used, status), a Create dialog (label + clientId/subject) that surfaces the new key once with copy + "store it now, you won't see it again", and per-row Revoke with confirm. Wire through `web/src/api/client.ts`.
6. **Audit** — record key_created / key_revoked as metadata only (id, label, clientId, prefix), never the key.
7. **Backward compatibility + migration** — existing env keys keep working; document moving them into the DB.
8. **Security review** — admin routes unreachable from the public edge; hash-at-rest; constant-time; no key in logs/audit/list responses; clientId scoping preserved.
9. **Test/verify plan** and a **definition-of-done checklist**.

## Binding constraints
- Reuse the existing store connection and auth/tenancy/audit machinery; do not fork them.
- Raw keys: shown once, hashed at rest, never logged/audited/listed. Use `node:crypto`.
- Admin routes never exposed through `api.jantra.in`; the intake widget and public flow are unaffected.
- TypeScript strict, ESM, Node >= 20; schema-validate all request bodies; keep `typecheck` and the existing `edge:verify` green.

## Output
Do not change code. Produce `docs/KEYCONSOLE_PLAN.md`, then stop and summarize the plan, the Step 2 decisions you made, and open questions for review. Build only after approval.

# Codex follow-up — add a remote API key generator (`npm run keys:gen`)

> Paste the block below to Codex. Small, self-contained: a CLI that mints a Jantra remote API key and prints the exact strings to paste into the origin env and the Worker secret. It does not change the auth model (keys stay env-based via `JANTRA_REMOTE_API_KEYS`).

---

Add a key-generator command so operators stop hand-rolling keys with `node -e`. The remote auth model stays exactly as-is: `parseApiKeyRecords()` reads `JANTRA_REMOTE_API_KEYS` as comma-separated `key:clientId:subject` records at boot. This task only generates well-formed values; it does not introduce a key store.

## Task
1. **New script** `src/server/keygen.ts` (run via `node --import tsx`), wired as `"keys:gen"` in `package.json` scripts.
2. **Behavior.** Generate a cryptographically secure key. Reuse the existing primitive — `generateLoopbackToken()` in `src/server/security.ts` already does `randomBytes(32).toString("base64url")`; either reuse it or add a sibling `generateApiKey()` there so both share one implementation. Do not invent a weaker scheme.
3. **Args** (all optional, with defaults): `--client <clientId>` (default `xolver`), `--subject <subject>` (default `web`). Parse from `process.argv`; no new dependency.
4. **Validate** that `clientId` and `subject` contain no `:` or `,` (those are the record delimiters) and are non-empty; fail with a clear message otherwise.
5. **Output** (to stdout, clearly labeled, no logging of secrets to files):
   - the bare key (this is what goes to the Worker: `wrangler secret put JANTRA_API_KEY`),
   - the full record line for the origin: `JANTRA_REMOTE_API_KEYS=<key>:<clientId>:<subject>`,
   - a one-line reminder: never commit the key; if `JANTRA_REMOTE_API_KEYS` already has records, append this one comma-separated.
6. **Docs.** Add a short "Generate a key" subsection to `deploy/cloudflare-worker/README.md` step 2 showing `npm run keys:gen -- --client xolver --subject web` and where each output goes. Update `.env.example`'s `JANTRA_REMOTE_API_KEYS` comment to point at the command.

## Constraints
- TypeScript strict, ESM, Node >= 20; no new runtime dependencies.
- The key must be generated with `node:crypto` (>= 32 bytes), never `Math.random`.
- Print to stdout only; do not write the key to any file or audit log.
- Keep `typecheck` green.

## Out of scope (note in your summary, do not build)
A DB-backed key store with runtime issue/list/revoke and hashed-at-rest keys is the multi-partner productization step. Not now: today is single-tenant (xolver) and env-based. Just make sure the generated record format stays compatible with that future store (`key:clientId:subject`).

## Verify
- `npm run keys:gen` prints a valid key and a record line; pasting the record into `JANTRA_REMOTE_API_KEYS` and the bare key into the Worker's `JANTRA_API_KEY` lets the edge -> origin happy path work (re-run `npm run edge:verify`).
- Bad input (`--client "a:b"`) is rejected with a clear error.
- `npm run typecheck` passes.

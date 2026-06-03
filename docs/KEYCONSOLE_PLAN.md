# Jantra API Key Console Plan

## Goal and Scope

Build an operator-only API key console for Jantra. An operator opens the existing Jantra console, creates a developer key, sees the raw key exactly once, hands it to a developer, and can revoke it later.

This replaces routine hand-editing of `JANTRA_REMOTE_API_KEYS`, but keeps that env var as a bootstrap fallback. This is not public self-serve. External developer signup, account auth, billing, email verification, org membership, and user-owned key management are later-phase work.

## Existing Surfaces to Reuse

- Store: `SqliteProjectStore` in `src/pipeline/store/sqlite.ts` opens one `jantra.sqlite` and runs `create table if not exists`. Add the key table there so the origin validates against the same database the operator writes.
- Auth: `src/server/auth/apiKeys.ts` already parses env key records, extracts bearer tokens, compares env keys via `timingSafeStringEqual`, and returns `Identity`.
- Tenancy: `Identity` carries `clientId`, `subject`, and `mode`; existing route code calls `requestClientId` and `assertProjectAccess`.
- Admin UI: `@jantra/web` already has a React console shell, react-query, settings, and `web/src/api/client.ts`.
- Edge: `deploy/cloudflare-worker/worker.js` allowlists only public intake paths. `/v1/admin/*` must stay absent from that worker and from `api.jantra.in`.

## Step 2 Decisions

### 1. Where Admin Routes Live

Admin key routes live on the Jantra origin as `/v1/admin/keys`, because the origin is the process with access to the SQLite database that remote API-key auth must validate against.

For v1 operator access, use private/local origin access, not the public intake edge:

- `api.jantra.in`: keep the current Cloudflare Worker and its five public intake routes only. Do not add `/v1/admin/*`.
- `admin.jantra.in`: not in v1. Add it later behind Cloudflare Access only when private origin access becomes real friction.
- Private/local access remains supported for the desktop console and internal operators by pointing the existing web console at the origin or local loopback API.

This keeps developer key management on the origin, keeps public intake isolated, and avoids building public self-serve auth in this phase.

### 2. Admin Auth Boundary

Gate every `/v1/admin/*` route with a dedicated `JANTRA_ADMIN_TOKEN`, compared with `timingSafeStringEqual`.

Use a separate header, `x-jantra-admin-token`, rather than overloading `Authorization`. That lets the console keep using its existing bearer token for loopback/local API calls while sending the admin token only to admin endpoints.

Remote API-key auth must skip `/v1/admin/*`; those routes are authenticated only by the admin guard. Local security should still apply host, origin, CORS, and loopback protection where relevant, but the admin action itself must require `JANTRA_ADMIN_TOKEN`, not merely the loopback token.

If `JANTRA_ADMIN_TOKEN` is missing, do not register the admin routes. Unknown admin paths 404, and the console treats that as "admin not enabled." They must never silently fall back to issued API keys or the loopback token.

### 3. Key Format and Storage

Generate keys with `node:crypto`:

- Raw format: `jntr_<base64url-random>`, using 32 random bytes for the random part.
- Example shape: `jntr_Zm9v...` (actual random part is longer).
- Metadata prefix: store a short display prefix such as the first 12 to 16 characters, enough for operators to identify a key but not enough to authenticate.
- Secret at rest: store only `sha256(rawKey)` as a hex digest. Never persist the raw key. These are 256-bit random tokens, not passwords, so fast deterministic SHA-256 is correct for lookup-by-hash.

The raw key is returned only by the create endpoint response and shown once in the console create dialog. It is never included in list responses, audit entries, logs, or persisted UI config.

### 4. Validation Path, Precedence, and Revocation Speed

On every remote bearer request:

1. Extract the bearer token.
2. Compute `sha256(token)`.
3. Look up the hash in the SQLite `api_keys` table.
4. If found and `revoked_at` is null, return `Identity { clientId, subject, mode: "remote" }` and touch `last_used_at` best-effort only when null or older than about 60 seconds.
5. If found and `revoked_at` is set, reject immediately. A revoked DB key must not be rescued by env fallback.
6. If not found in DB, check `JANTRA_REMOTE_API_KEYS` records with the existing constant-time env comparison.
7. If neither source matches, reject.

Precedence is DB first, env fallback second. Revoke takes effect on the next request because there is no positive auth cache. `last_used_at` is observability only and must never make auth fail.

## Database Schema

Add table creation in `SqliteProjectStore` construction, using the same `jantra.sqlite` connection:

```sql
create table if not exists api_keys (
  id text primary key,
  key_hash text not null unique,
  prefix text not null,
  client_id text not null,
  subject text not null,
  label text not null,
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create index if not exists idx_api_keys_client_id_created_at
  on api_keys (client_id, created_at desc);

create index if not exists idx_api_keys_revoked_at
  on api_keys (revoked_at);
```

Notes:

- `key_hash` is the authentication lookup key.
- `prefix` is non-secret display metadata only.
- `client_id` preserves tenant scoping.
- `subject` identifies the developer, integration, or worker using the key.
- `label` is operator-facing and should be validated to a bounded length.
- `revoked_at` is nullable so revocation is immutable metadata rather than deletion.

## Store Methods

Add a small key-store interface rather than forcing JSON project storage to implement key management:

```ts
export interface ApiKeyMetadata {
  id: string;
  prefix: string;
  clientId: string;
  subject: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface StoredApiKeyRecord extends ApiKeyMetadata {
  keyHash: string;
}

export interface ApiKeyStore {
  createApiKey(record: StoredApiKeyRecord): ApiKeyMetadata;
  getApiKeyByHash(keyHash: string): StoredApiKeyRecord | null;
  listApiKeys(query: { clientId?: string; includeRevoked?: boolean }): ApiKeyMetadata[];
  revokeApiKey(id: string, revokedAt: string): ApiKeyMetadata | null;
  touchApiKeyLastUsed(id: string, usedAt: string): void;
}
```

Implementation:

- `SqliteProjectStore` implements both `ProjectStore` and `ApiKeyStore`.
- Remote origin startup must instantiate one `SqliteProjectStore` and pass that same instance to both project routes and API-key auth.
- The desktop app already starts the local API with `new SqliteProjectStore(desktopDatabasePath())`; admin key methods should live on that same instance.
- Avoid adding API-key methods to `JsonProjectStore` except as an explicit unsupported fallback for tests. Key issuance should require SQLite.

## Auth Changes

Update `src/server/auth/apiKeys.ts` without changing its public intent:

- Keep `parseApiKeyRecords()` for env fallback.
- Add a hash helper using `createHash("sha256")`.
- Change DB-backed resolution to accept `{ apiKeyStore?: ApiKeyStore; envRecords: ApiKeyRecord[] }`.
- Keep env matching constant-time with `timingSafeStringEqual`.
- Do not log tokens, hashes, or full prefixes.
- On successful DB auth, update `last_used_at` after identity resolution only when it is null or older than about 60 seconds. If the touch fails, log and continue. Revocation correctness comes from reading `revoked_at`, not from the metadata touch.

Remote-mode auth hook should skip `/v1/admin/*` because admin routes have their own guard. All non-admin `/v1` routes continue to require developer API-key auth.

## Admin API

Register a new route module, for example `src/server/routes/adminKeys.ts`.

All routes:

- Require `x-jantra-admin-token` matching `JANTRA_ADMIN_TOKEN`.
- Validate params, query, and bodies with Zod in `src/server/schemas.ts`.
- Return metadata only except for the one create response.
- Add `cache-control: no-store`.

### `POST /v1/admin/keys`

Body:

```ts
{
  label: string;
  clientId: string;
  subject: string;
}
```

Validation:

- `label`: 1 to 120 chars.
- `clientId`: 1 to 96 chars, conservative slug-like format if existing tenant IDs allow it.
- `subject`: 1 to 160 chars.

Response:

```ts
{
  key: "jntr_...",
  apiKey: {
    id: "...",
    prefix: "jntr_abc123...",
    clientId: "xolver",
    subject: "developer@example.com",
    label: "Website intake worker",
    createdAt: "...",
    lastUsedAt: null,
    revokedAt: null
  }
}
```

The `key` field exists only here. The route hashes before storage and returns after the insert succeeds.

### `GET /v1/admin/keys`

Query:

```ts
{
  clientId?: string;
  includeRevoked?: boolean;
}
```

Response:

```ts
{
  items: ApiKeyMetadata[]
}
```

No raw key and no hash. The default list can include active keys only, with a UI toggle for revoked keys.

### `POST /v1/admin/keys/:id/revoke`

Behavior:

- Set `revoked_at` if it is null.
- Return metadata for the key.
- Treat a second revoke as idempotent and return the already revoked metadata.
- Return 404 for unknown IDs.

## Console Page

Add an "API Keys" route to `@jantra/web`:

- Extend `web/src/app/App.tsx` view state with `apiKeys`.
- Add a side-nav item using a lucide key icon.
- Add `web/src/routes/ApiKeys.tsx`.
- Extend `web/src/api/client.ts` with:
  - `ApiKeyMetadata` types.
  - `createApiKey`.
  - `listApiKeys`.
  - `revokeApiKey`.
  - admin-token config stored separately from the loopback token.

Settings changes:

- Add an "Admin token" setting to `Settings`.
- Store it in localStorage under a separate key, or read it from `window.JANTRA_DESKTOP` if desktop injects it. localStorage is XSS-exposed and acceptable only for the v1 operator console; prefer desktop injection where available.
- Send it only as `x-jantra-admin-token` for admin endpoints.

API Keys page behavior:

- Table columns: label, prefix, client ID, subject, created, last used, status, actions.
- Create button opens a dialog with label, client ID, and subject.
- After create succeeds, show the full raw key once with a copy button and the warning: "Store this key now. Jantra will not show it again."
- Keep the raw key only in transient React state. Clear it when the dialog closes.
- Revoke action requires confirmation and then refreshes the list.
- Show revoked keys with muted styling and disabled revoke buttons.

## Audit

Add audit event types:

- `key_created`
- `key_revoked`

Record to the existing audit trail as metadata only. Use a stable admin audit run id such as `admin` unless a better existing global audit sink is added.

`key_created` fields:

- `clientId`
- `keyId`
- `prefix`
- `label`
- `subject`

`key_revoked` fields:

- `clientId`
- `keyId`
- `prefix`
- `label`
- `subject`
- `revokedAt`

Never audit:

- Raw key.
- Key hash.
- Authorization header.
- `x-jantra-admin-token`.

## Backward Compatibility and Migration

`JANTRA_REMOTE_API_KEYS` remains supported as a bootstrap fallback. This preserves existing workers and gives operators an emergency out-of-band path if the DB key console is unavailable.

Recommended migration:

1. Start origin with existing `JANTRA_REMOTE_API_KEYS` and `JANTRA_ADMIN_TOKEN`.
2. Open the console through the admin access path.
3. Create replacement DB-backed keys for each integration.
4. Update each integration or Worker secret to use the DB-backed key.
5. Confirm `last_used_at` updates for the new key.
6. Remove the old env key from `JANTRA_REMOTE_API_KEYS` after all traffic moves.

Env keys cannot be revoked from the console. Their revocation remains removing them from env and restarting/redeploying the origin or Worker secret, depending on where they are used.

## Security Review

- Admin routes live on the origin and are not reachable through the public intake Worker.
- `api.jantra.in` must keep rejecting `/v1/admin/*`; update `edge:verify` to assert that explicitly if it does not already.
- `admin.jantra.in`, if used, is a separate protected access path with its own allowlist and access control.
- `JANTRA_ADMIN_TOKEN` is separate from developer keys and loopback tokens.
- Raw developer keys are shown once, then lost.
- Stored credentials are SHA-256 hashes only.
- The display prefix is non-secret and never sufficient to authenticate.
- DB-backed revoke takes effect on the next request.
- Env fallback preserves bootstrap access but is intentionally not console-revocable.
- Every issued identity preserves `clientId` and `subject`.
- All request bodies and params are schema-validated.
- Responses use `cache-control: no-store`.
- No key material appears in logs, audit, route errors, list responses, or UI persistence.

## Later Self-Serve Plug-In Point

Public self-serve would reuse the same `api_keys` table and `ApiKeyStore`, but replace the operator admin guard with real public auth and account ownership:

- Developer accounts and organizations.
- Email or SSO login.
- Billing and rate limits.
- Actor ownership on every key.
- User-scoped list/revoke routes.
- A separate public app route, not the operator console.

Do not build any of this in v1.

## Implementation Order After Approval

1. Add `ApiKeyStore` types and SQLite schema/methods.
2. Add DB-backed API-key auth with env fallback and no auth cache.
3. Add admin-token guard and admin key routes.
4. Wire remote/local server startup so the same `SqliteProjectStore` instance backs project routes and key auth.
5. Add metadata-only audit events.
6. Add web API client methods and admin token config.
7. Add the API Keys route/page and nav item.
8. Extend edge verification to prove `/v1/admin/*` remains blocked on the public edge.
9. Run typecheck and targeted tests.

## Test and Verify Plan

Store tests:

- Creates the `api_keys` table in the same SQLite DB.
- Inserts a key record and returns metadata only.
- Looks up by hash.
- Lists by client ID.
- Revokes idempotently.
- Updates `last_used_at`.

Auth tests:

- Valid DB key resolves to expected `Identity`.
- Revoked DB key is rejected.
- Unknown DB key falls back to valid env key.
- Revoked DB key with the same raw token is rejected before env fallback.
- Invalid bearer token is rejected.
- `/v1/admin/*` is skipped by developer-key auth and handled by admin guard.

Admin route tests:

- Missing or wrong `x-jantra-admin-token` is rejected.
- Create returns the raw key once and stores only the hash.
- List never returns raw key or hash.
- Revoke sets `revoked_at`.
- Create/revoke audit events contain metadata only.
- Bodies and params reject invalid shapes.

Console tests:

- API Keys page lists metadata.
- Create dialog shows the raw key once.
- Closing the dialog clears the raw key from React state.
- Revoke requires confirmation and refreshes list.
- Admin token setting is separate from loopback token.

Edge tests:

- Existing public intake paths still pass.
- `/v1/admin/keys` on the public edge is blocked.
- `npm run edge:verify` remains green.

Commands:

- `npm run typecheck`
- `npm run edge:verify`
- Any targeted route/store tests added with the implementation

## Definition of Done Checklist

- [ ] `api_keys` table exists in the same `jantra.sqlite` used by the origin.
- [ ] DB-backed keys validate remote requests.
- [ ] `JANTRA_REMOTE_API_KEYS` still works as fallback.
- [ ] Revoked DB keys fail on the next request.
- [ ] Admin routes require `JANTRA_ADMIN_TOKEN`.
- [ ] Admin routes are not exposed through `api.jantra.in`.
- [ ] Raw keys are returned only on create and never persisted.
- [ ] List responses and audit entries contain metadata only.
- [ ] Console has list, create, one-time reveal, copy, and revoke flows.
- [ ] `clientId` and `subject` flow into `Identity`.
- [ ] Request bodies and params are schema-validated.
- [ ] `npm run typecheck` passes.
- [ ] `npm run edge:verify` passes.

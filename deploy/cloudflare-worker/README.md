# Jantra hosted service — deploy

Two pieces: a private Node origin (the API + agent) and a public Cloudflare
Worker edge in front of it. The browser only ever talks to the edge.

```
Browser  ->  Cloudflare Worker (api.jantra.in)  ->  private Node origin
            holds key, CORS, rate limit             startRemoteApi, SQLite on disk
```

## 1. Private Node origin

Run the remote API on an always-on Node host **with a persistent disk** (Fly.io,
Railway, Render, a small VPS — anything that keeps a filesystem; not Workers,
because the store is `better-sqlite3`).

Env:

```bash
GEMINI_API_KEY=...                       # model key
JANTRA_REMOTE_API_KEYS=<key>:xolver:web  # key -> clientId(xolver) -> subject(web)
JANTRA_MODEL_INTAKE=flash                # cheap/fast for public intake
JANTRA_COST_CEILING_USD=2                # low ceiling per run for the public agent
JANTRA_PROJECT_DIR=/data/jantra/projects # on the persistent volume
JANTRA_AUDIT_DIR=/data/jantra/audit      # on the persistent volume
JANTRA_SERVER_PORT=4317
```

Start:

```bash
npm install
npm run build
npm run server:remote
```

Keep this origin private (firewall / internal network / a hostname only the
Worker resolves). It performs no CORS and no Origin checks by design.

## 2. Public Worker edge

```bash
cd deploy/cloudflare-worker
# edit wrangler.toml: set JANTRA_ORIGIN (private origin URL) and ALLOWED_ORIGINS
wrangler secret put JANTRA_API_KEY      # the <key> from JANTRA_REMOTE_API_KEYS
wrangler deploy
# bind api.jantra.in to the Worker (custom domain route)
```

The Worker holds the key, answers CORS for the allowed embedding origins,
whitelists only the intake request shapes (create / advance / read-own /
answer — never the tenant-wide list or audit endpoints), injects the bearer
key, applies the rate-limit binding in `wrangler.toml`, and forwards to the
origin.

Current public edge limits:

- Per-IP rate limit: 15 requests per 60 seconds via the `RATE_LIMITER` binding.
- Public request body cap: 16 KB before the request is forwarded to the origin.
- Origin timeout: 25 seconds, after which the Worker returns `504`.
- Allowed browser routes only: `POST /v1/runs`, `GET /v1/runs/:id`,
  `POST /v1/runs/:id/advance`, `GET /v1/runs/:id/interactions`, and
  `POST /v1/runs/:id/interactions/:interactionId`.
- Blocked from the browser edge: tenant-wide `GET /v1/runs`, audit routes,
  artifact routes, source routes, agent registry routes, confirm/reject, and
  every non-intake path.

## 3. Point the consumer at it

On the Xolver site (and any other embed), set the widget base URL to the edge:
`https://api.jantra.in`. No key in the browser. See `docs/EMBEDDING_GUIDE.md`.

## Local development

To exercise the widget against a local origin without the edge, run the local
server and allow your dev origin:

```bash
JANTRA_PROVIDER=mock \
JANTRA_LOOPBACK_TOKEN=dev-token \
JANTRA_ALLOWED_ORIGINS=http://localhost:5176 \
npm run server
```

Then point the widget at `http://127.0.0.1:4317` with `apiKey: "dev-token"`.

To verify the production path, run the private origin in remote mode and put the
Worker in front of it:

```bash
JANTRA_PROVIDER=mock \
JANTRA_REMOTE_API_KEYS=edge-test-key:xolver:web \
JANTRA_SERVER_PORT=4327 \
npm run server:remote

cd deploy/cloudflare-worker
wrangler dev worker.js --local --port 8787 \
  --var JANTRA_ORIGIN:http://127.0.0.1:4327 \
  --var ALLOWED_ORIGINS:http://localhost:5176 \
  --var JANTRA_API_KEY:edge-test-key
```

In another shell from the repo root:

```bash
JANTRA_EDGE_URL=http://127.0.0.1:8787 \
JANTRA_EDGE_TEST_ORIGIN=http://localhost:5176 \
npm run edge:verify
```

The verifier drives `POST /v1/runs`, a bodyless
`POST /v1/runs/:id/advance`, and the answer POST through the Worker URL. It
also checks the 16 KB body cap, non-JSON rejection, blocked tenant-wide routes,
Origin rejection, and rate limiting.

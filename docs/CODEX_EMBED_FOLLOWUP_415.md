# Codex follow-up — fix the Worker 415 on bodyless `advance`, then verify through the edge

> Paste the block below to Codex. Two tasks: a production-breaking fix in the Cloudflare Worker, and the end-to-end verification that would have caught it.

---

Your hardening pass introduced a production-breaking bug in `deploy/cloudflare-worker/worker.js`, and the verification missed it because the local browser test pointed the widget straight at the origin, never through the Worker. Fix it, then add the missing through-the-edge verification.

## The bug
The intake widget makes three POSTs. `create` and `answer` carry a JSON body, so the widget sets `Content-Type: application/json`. But **`advance` is a bodyless POST** — the widget only sets the content-type when there is a body:

```js
if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
// advance: request(`/v1/runs/${runId}/advance`, { method: "POST" })  -> no body, no content-type
```

Your new `readRequestBody` requires `application/json` on **every** POST:

```js
if (request.method !== "POST") return undefined;
const contentType = request.headers.get("Content-Type") ?? "";
if (!contentType.toLowerCase().includes("application/json")) {
  return { error: new Response("Unsupported Media Type", { status: 415 }) };  // advance hits this
}
```

So through the edge the flow is: `create` 200 -> `advance` **415** -> the conversation dies after the first question. The origin (Fastify) accepts the bodyless `advance` fine (confirmed: `advance(no body) -> 200 awaiting_input`), which is why direct-to-origin testing passed.

## Task 1 — fix `readRequestBody`
Read the body once; treat empty as a valid bodyless POST; enforce JSON + size cap only when a body exists:

```js
async function readRequestBody(request) {
  if (request.method !== "POST") return undefined;
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return { body: undefined };            // bodyless POST, e.g. /advance
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { error: new Response("Unsupported Media Type", { status: 415 }) };
  }
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return { error: new Response("Payload Too Large", { status: 413 }) };
  }
  return { body };
}
```

This drops the `Content-Length` header pre-check; capping on actual `byteLength` is what matters and Cloudflare caps request size upstream. Keep `body: bodyResult?.body` flowing to the upstream fetch unchanged.

## Task 2 — verify the full loop THROUGH the Worker (this is the step that was missing)
Run the Worker locally (`wrangler dev` / miniflare) with `JANTRA_ORIGIN` pointed at a running mock origin (`JANTRA_PROVIDER=mock npm run server`, with `JANTRA_REMOTE_API_KEYS` set and the Worker's `JANTRA_API_KEY` matching), `ALLOWED_ORIGINS` including your test origin. Then confirm, against the Worker URL (not the origin):

1. **Happy path survives the edge:** `POST /v1/runs` -> `POST /v1/runs/:id/advance` (bodyless) -> `POST /v1/runs/:id/interactions/:iid` -> `awaiting_confirmation` with an `idea_summary`. The `advance` step must return 200, not 415.
2. **Bodyless POST is allowed; oversized JSON still 413s** (> 16 KB), non-JSON body still 415s.
3. **Blocking still holds:** tenant-wide `GET /v1/runs`, audit, artifact, source, agent-registry, and confirm/reject routes are all rejected; bad/missing Origin rejected; rate limit triggers.
4. Drive the actual Xolver widget once with `VITE_JANTRA_BASE_URL` set to the local Worker URL, and confirm the browser conversation completes with no console errors.

Keep both repos building (typecheck + builds green). Report what you changed and paste the through-the-edge results, including the `advance` status code.

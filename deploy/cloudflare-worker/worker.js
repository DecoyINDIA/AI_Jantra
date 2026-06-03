// Jantra public edge — Cloudflare Worker.
//
// This is the only public-facing surface of the Jantra service. It:
//   1. holds the real Jantra API key as a Worker secret (the browser never sees it),
//   2. allowlists the embedding site Origin and answers CORS,
//   3. whitelists ONLY the intake paths a visitor needs (so the shared-tenant
//      list/audit endpoints cannot leak other visitors' intakes),
//   4. rate-limits per IP (optional native binding),
//   5. forwards to the private Jantra origin with the key injected.
//
// Bindings (set in wrangler.toml / dashboard):
//   JANTRA_ORIGIN     var  e.g. "https://jantra-origin.internal" (private Node API)
//   ALLOWED_ORIGINS   var  comma list, e.g. "https://xolver.in,https://www.xolver.in"
//   JANTRA_API_KEY    secret  the bearer key matching a JANTRA_REMOTE_API_KEYS record
//   RATE_LIMITER      (optional) a [[unsafe.bindings]] ratelimit binding

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const MAX_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;

// Exact request shapes the public intake widget is allowed to make. Anything
// else (notably GET /v1/runs which lists the whole tenant) is rejected.
const ROUTES = [
  { method: "POST", re: /^\/v1\/runs$/ },
  { method: "GET", re: /^\/v1\/runs\/[^/]+$/ },
  { method: "POST", re: /^\/v1\/runs\/[^/]+\/advance$/ },
  { method: "GET", re: /^\/v1\/runs\/[^/]+\/interactions$/ },
  { method: "POST", re: /^\/v1\/runs\/[^/]+\/interactions\/[^/]+$/ },
];

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Max-Age": "600",
  };
}

function deny(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

async function readRequestBody(request) {
  if (request.method !== "POST") return undefined;
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return { body: undefined };
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { error: new Response("Unsupported Media Type", { status: 415 }) };
  }
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return { error: new Response("Payload Too Large", { status: 413 }) };
  }
  return { body };
}

async function fetchWithTimeout(target, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(target, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allow = allowedOrigins(env);
    const originOk = origin && allow.includes(origin);

    if (request.method === "OPTIONS") {
      if (!originOk) return deny(403, "Origin not allowed.");
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // A browser request must carry an allowed Origin. (Server-to-server callers
    // should use the origin directly with their own key, not this edge.)
    if (!originOk) return deny(403, "Origin not allowed.", null);

    const route = ROUTES.find((r) => r.method === request.method && r.re.test(url.pathname));
    if (!route) return deny(404, "Not found.", origin);

    if (!env.JANTRA_ORIGIN || !env.JANTRA_API_KEY) {
      return deny(500, "Jantra edge is not configured.", origin);
    }

    // Optional per-IP rate limit.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "anon";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return deny(429, "Too many requests.", origin);
    }

    const bodyResult = await readRequestBody(request);
    if (bodyResult?.error) {
      return deny(bodyResult.error.status, await bodyResult.error.text(), origin);
    }

    const target = `${env.JANTRA_ORIGIN.replace(/\/$/, "")}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${env.JANTRA_API_KEY}`);
    headers.delete("Origin"); // origin-side CORS stays off; the edge owns CORS
    headers.delete("Cookie");

    let upstream;
    try {
      upstream = await fetchWithTimeout(target, {
        method: request.method,
        headers,
        body: bodyResult?.body,
      });
    } catch {
      return deny(504, "Jantra origin timed out.", origin);
    }

    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) respHeaders.set(k, v);
    respHeaders.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};

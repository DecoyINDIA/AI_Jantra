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
//   JANTRA_EDGE_SECRET   secret  (recommended) sent to the origin as
//                        X-Jantra-Edge-Secret; must match the origin's value
//   TURNSTILE_SECRET_KEY secret  (recommended) when set, creating a run or a
//                        lead requires a valid Cloudflare Turnstile token in
//                        the CF-Turnstile-Response header

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const MAX_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;
const TURNSTILE_HEADER = "CF-Turnstile-Response";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;
// Per-run secret returned by POST /v1/runs; the origin requires it on every
// later call for that run. It is the only X-Jantra-* header a browser may send
// besides X-Jantra-User.
const RUN_TOKEN_HEADER = "x-jantra-run-token";
const BROWSER_JANTRA_HEADERS = new Set(["x-jantra-user", RUN_TOKEN_HEADER]);

// Exact request shapes the public intake widget is allowed to make. Anything
// else (notably GET /v1/runs which lists the whole tenant) is rejected.
const ROUTES = [
  // challenge: true marks the calls that start spend or store personal data;
  // they need a fresh Turnstile token when TURNSTILE_SECRET_KEY is set.
  { method: "POST", re: /^\/v1\/runs$/, challenge: true },
  { method: "GET", re: /^\/v1\/runs\/[^/]+$/ },
  { method: "POST", re: /^\/v1\/runs\/[^/]+\/advance$/ },
  { method: "GET", re: /^\/v1\/runs\/[^/]+\/interactions$/ },
  { method: "POST", re: /^\/v1\/runs\/[^/]+\/interactions\/[^/]+$/ },
  { method: "POST", re: /^\/v1\/leads$/, challenge: true },
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
    "Access-Control-Allow-Headers": `content-type, ${TURNSTILE_HEADER.toLowerCase()}, ${RUN_TOKEN_HEADER}`,
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

// Fail closed: any error talking to Cloudflare, or a token minted for a site
// we do not serve, is treated as a failed challenge.
async function verifyTurnstile(env, token, visitorIp) {
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (visitorIp) form.append("remoteip", visitorIp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    // TURNSTILE_VERIFY_URL exists only so the local harness can stub Cloudflare.
    const response = await fetch(env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const outcome = await response.json();
    if (outcome?.success !== true) return false;
    const hosts = allowedOrigins(env).map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return null;
      }
    });
    return typeof outcome.hostname === "string" && hosts.includes(outcome.hostname);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

    // After the cheap body checks, so malformed requests never cost a
    // siteverify round trip.
    if (route.challenge && env.TURNSTILE_SECRET_KEY) {
      const passed = await verifyTurnstile(
        env,
        request.headers.get(TURNSTILE_HEADER),
        request.headers.get("CF-Connecting-IP"),
      );
      if (!passed) return deny(403, "Verification challenge failed.", origin);
    }

    const target = `${env.JANTRA_ORIGIN.replace(/\/$/, "")}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("x-jantra-") && !BROWSER_JANTRA_HEADERS.has(name.toLowerCase())) {
        headers.delete(name);
      }
    }
    headers.delete(TURNSTILE_HEADER);
    if (env.JANTRA_EDGE_SECRET) headers.set("X-Jantra-Edge-Secret", env.JANTRA_EDGE_SECRET);
    const visitorIp = request.headers.get("CF-Connecting-IP");
    if (visitorIp) headers.set("X-Jantra-Client-IP", visitorIp);
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

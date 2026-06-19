import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Dependency-free fixed-window rate limiter for the remote API surface.
 *
 * Kept in-process and dependency-free on purpose: the remote runtime is a single
 * origin (Railway) behind Cloudflare, so a shared-memory fixed window is enough
 * to blunt brute-force and spam-run abuse without pulling in a plugin or an
 * external store. If the deployment ever scales horizontally, swap this for a
 * shared-store limiter (Redis) — the install hook stays the same.
 */
export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const SWEEP_EVERY = 1000;

export function createFixedWindowLimiter(
  options: RateLimitOptions,
): (key: string) => RateVerdict {
  const windowMs = Math.max(1, Math.trunc(options.windowMs));
  const max = Math.max(1, Math.trunc(options.max));
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  function sweep(currentMs: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentMs) buckets.delete(key);
    }
  }

  return function check(key: string): RateVerdict {
    const currentMs = now();
    // Amortized cleanup so the map cannot grow unbounded under key churn (e.g.
    // a flood of distinct spoofed IPs); each entry is also lazily expired below.
    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      sweep(currentMs);
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentMs) {
      bucket = { count: 0, resetAt: currentMs + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - currentMs) / 1000)),
      resetAt: bucket.resetAt,
    };
  };
}

function clientKey(request: FastifyRequest): string {
  // With trustProxy enabled (remote mode), request.ip is the real client IP
  // parsed from X-Forwarded-For; otherwise it is the socket peer address.
  return request.ip || request.socket?.remoteAddress || "unknown";
}

/**
 * Install a fixed-window limiter as an onRequest hook over the /v1 surface.
 * Register this BEFORE auth so unauthenticated floods and API-key brute-force
 * attempts are throttled too.
 */
export function installRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  const max = Math.max(1, Math.trunc(options.max));
  const check = createFixedWindowLimiter(options);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1")) return;
    const verdict = check(clientKey(request));
    reply.header("X-RateLimit-Limit", String(max));
    reply.header("X-RateLimit-Remaining", String(verdict.remaining));
    if (!verdict.allowed) {
      reply.header("Retry-After", String(verdict.retryAfterSec));
      return reply.status(429).send({
        error: {
          code: "rate_limited",
          message: "Too many requests. Slow down and retry shortly.",
          details: { retryAfterSeconds: verdict.retryAfterSec },
        },
      });
    }
  });
}

import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { timingSafeStringEqual } from "./constantTime.js";
import { forbidden, unauthorized } from "./errors.js";

const DEFAULT_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

export interface LocalSecurityOptions {
  loopbackToken: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

export function generateLoopbackToken(): string {
  return randomBytes(32).toString("base64url");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostName(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function originValue(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function requestToken(request: FastifyRequest): string | null {
  const auth = headerValue(request.headers.authorization);
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return headerValue(request.headers["x-jantra-loopback-token"]) ?? null;
}

export function validateLocalHostHeader(
  request: FastifyRequest,
  allowedHosts: Set<string> = DEFAULT_ALLOWED_HOSTS,
): void {
  const host = hostName(headerValue(request.headers.host));
  if (!host || !allowedHosts.has(host)) {
    throw forbidden("Unexpected Host header for local Jantra API.");
  }
}

export function validateOrigin(
  request: FastifyRequest,
  allowedOrigins: Set<string> = DEFAULT_ALLOWED_ORIGINS,
): string | null {
  const origin = originValue(headerValue(request.headers.origin));
  if (!origin) return null;
  if (!allowedOrigins.has(origin)) {
    throw forbidden("Origin is not allowed for local Jantra API.");
  }
  return origin;
}

function setCorsHeaders(reply: FastifyReply, origin: string | null): void {
  if (!origin) return;
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Headers", "authorization, content-type, x-jantra-loopback-token");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export function installLocalSecurity(
  app: FastifyInstance,
  opts: LocalSecurityOptions,
): void {
  const allowedHosts = new Set([...(opts.allowedHosts ?? []), ...DEFAULT_ALLOWED_HOSTS]);
  const allowedOrigins = new Set([
    ...(opts.allowedOrigins ?? []),
    ...DEFAULT_ALLOWED_ORIGINS,
  ]);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1")) return;

    validateLocalHostHeader(request, allowedHosts);
    const origin = validateOrigin(request, allowedOrigins);
    setCorsHeaders(reply, origin);

    if (request.method === "OPTIONS") {
      reply.status(204).send();
      return reply;
    }

    if (!timingSafeStringEqual(requestToken(request), opts.loopbackToken)) {
      throw unauthorized("Missing or invalid Jantra loopback token.");
    }
  });
}

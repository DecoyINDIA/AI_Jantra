import { createHash } from "node:crypto";
import * as net from "node:net";
import type { FastifyRequest } from "fastify";

/**
 * Resolves the effective visitor IP address for a request.
 * For authenticated requests with public key scope, trusts the X-Jantra-Client-IP
 * header injected by the edge proxy. Otherwise, falls back to Fastify request.ip.
 */
export function visitorAddress(request: FastifyRequest): string {
  if (request.identity?.scope === "public") {
    const header = request.headers["x-jantra-client-ip"];
    const raw = Array.isArray(header)
      ? header[0]
      : typeof header === "string"
        ? header.split(",")[0]
        : undefined;
    const value = raw?.trim();
    if (value && net.isIP(value) !== 0) {
      return value;
    }
  }
  return request.ip;
}

/**
 * Truncated SHA-256 hash of the visitor address used as a privacy-safe storage
 * key and rate-limiting identifier.
 */
export function visitorKey(request: FastifyRequest): string {
  return createHash("sha256").update(visitorAddress(request)).digest("hex").slice(0, 16);
}

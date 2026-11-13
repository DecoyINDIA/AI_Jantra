import { config } from "../config.js";
import { HttpError } from "./errors.js";
import type { Identity, KeyScope } from "./tenancy.js";

export function scopeForSubject(subject: string): {
  scope: KeyScope;
  allowedAgentIds?: string[];
} {
  if (config.publicSubjects.includes(subject)) {
    return {
      scope: "public",
      allowedAgentIds: [...config.publicAgentIds],
    };
  }
  return {
    scope: "full",
  };
}

const PUBLIC_ROUTE_PATTERNS: Array<{ method: string; regex: RegExp }> = [
  { method: "POST", regex: /^\/v1\/runs$/ },
  { method: "GET", regex: /^\/v1\/runs\/[^/]+$/ },
  { method: "POST", regex: /^\/v1\/runs\/[^/]+\/advance$/ },
  { method: "GET", regex: /^\/v1\/runs\/[^/]+\/interactions$/ },
  { method: "POST", regex: /^\/v1\/runs\/[^/]+\/interactions\/[^/]+$/ },
  { method: "POST", regex: /^\/v1\/leads$/ },
  { method: "GET", regex: /^\/v1\/leads$/ },
];

export function isPublicRouteAllowed(method: string, path: string): boolean {
  const upperMethod = method.toUpperCase();
  return PUBLIC_ROUTE_PATTERNS.some(
    (entry) => entry.method === upperMethod && entry.regex.test(path),
  );
}

export function assertAgentAllowed(
  identity: Identity | undefined,
  agentId: string,
): void {
  if (!identity || identity.scope === "full") return;
  const allowed = identity.allowedAgentIds ?? config.publicAgentIds;
  if (!allowed.includes(agentId)) {
    throw new HttpError(403, "agent_not_allowed", "This key cannot use the requested agent.");
  }
}

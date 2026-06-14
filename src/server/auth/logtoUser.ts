import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";

// End-user identity verification.
//
// The marketing site authenticates visitors with Logto (OIDC). When a logged-in
// visitor submits a lead, the SPA mints an access token for the Jantra API
// resource and the edge proxy forwards it in the `x-jantra-user` header (the
// proxy itself owns the `Authorization` service key, so user identity travels in
// a side channel). Here we verify that token against Logto's JWKS so a lead can
// be attributed to a real account — and so a user can only ever list their own
// leads. Identity is NEVER trusted from the request body.
//
// All three values are overridable for non-prod Logto tenants.
const ISSUER = process.env.JANTRA_LOGTO_ISSUER ?? "https://auth.xolver.in/oidc";
const AUDIENCE = process.env.JANTRA_LOGTO_AUDIENCE ?? "https://api.jantra.in";
const JWKS_URL =
  process.env.JANTRA_LOGTO_JWKS_URL ?? "https://auth.xolver.in/oidc/jwks";

// createRemoteJWKSet caches keys and only refetches on unknown `kid`, so this is
// safe to hold as a module singleton.
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export interface VerifiedUser {
  sub: string;
  email?: string;
}

const USER_TOKEN_HEADER = "x-jantra-user";

function userToken(request: FastifyRequest): string | null {
  const raw = request.headers[USER_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed.replace(/^Bearer\s+/i, "") : null;
}

/**
 * Verify the forwarded Logto access token, if any. Returns null when no token
 * is present (anonymous visitor) and throws only when a token is present but
 * invalid — callers decide whether identity is required for the route.
 */
export async function verifyOptionalUser(
  request: FastifyRequest,
): Promise<VerifiedUser | null> {
  const token = userToken(request);
  if (!token) return null;

  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { sub: payload.sub, email };
}

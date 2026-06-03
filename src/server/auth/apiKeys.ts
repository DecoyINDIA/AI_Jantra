import type { FastifyInstance, FastifyRequest } from "fastify";

import { timingSafeStringEqual } from "../constantTime.js";
import { unauthorized } from "../errors.js";
import type { Identity } from "../tenancy.js";

export interface ApiKeyRecord {
  key: string;
  clientId: string;
  subject: string;
}

export function parseApiKeyRecords(raw = process.env.JANTRA_REMOTE_API_KEYS ?? ""): ApiKeyRecord[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, clientId, subject] = item.split(":");
      if (!key || !clientId) {
        throw new Error("JANTRA_REMOTE_API_KEYS entries must be key:clientId[:subject].");
      }
      return { key, clientId, subject: subject ?? clientId };
    });
}

function bearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

export function resolveApiKeyIdentity(
  request: FastifyRequest,
  records: ApiKeyRecord[],
): Identity {
  const token = bearerToken(request);
  const record = token
    ? records.find((candidate) => timingSafeStringEqual(token, candidate.key))
    : null;
  if (!record) throw unauthorized("Missing or invalid API key.");
  return {
    subject: record.subject,
    clientId: record.clientId,
    mode: "remote",
  };
}

export function installApiKeyAuth(app: FastifyInstance, records: ApiKeyRecord[]): void {
  if (!records.length) {
    throw new Error("Remote API mode requires at least one API key record.");
  }
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1")) return;
    request.identity = resolveApiKeyIdentity(request, records);
  });
}

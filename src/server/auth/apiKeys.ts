import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ApiKeyStore, StoredApiKeyRecord } from "../../pipeline/store.js";
import { timingSafeStringEqual } from "../constantTime.js";
import { unauthorized } from "../errors.js";
import type { Identity } from "../tenancy.js";

export interface ApiKeyRecord {
  key: string;
  clientId: string;
  subject: string;
}

export interface ApiKeyAuthOptions {
  apiKeyStore?: ApiKeyStore;
  envRecords: ApiKeyRecord[];
}

const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

function isAdminPath(url: string): boolean {
  return url === "/v1/admin" || url.startsWith("/v1/admin/");
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

export function hashApiKey(rawKey: string): string {
  // API keys are 256-bit random bearer tokens, not human passwords. SHA-256 is
  // intentionally fast and deterministic so auth can do lookup-by-hash.
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function shouldTouchLastUsed(record: StoredApiKeyRecord, nowMs = Date.now()): boolean {
  if (!record.lastUsedAt) return true;
  const lastMs = Date.parse(record.lastUsedAt);
  return !Number.isFinite(lastMs) || nowMs - lastMs >= LAST_USED_TOUCH_INTERVAL_MS;
}

function touchLastUsedBestEffort(store: ApiKeyStore, record: StoredApiKeyRecord): void {
  if (!shouldTouchLastUsed(record)) return;
  try {
    store.touchApiKeyLastUsed(record.id, new Date().toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Failed to touch API key last_used_at.", { keyId: record.id, message });
  }
}

export function resolveApiKeyIdentity(
  request: FastifyRequest,
  optionsOrRecords: ApiKeyAuthOptions | ApiKeyRecord[],
): Identity {
  const options = Array.isArray(optionsOrRecords)
    ? { envRecords: optionsOrRecords }
    : optionsOrRecords;
  const token = bearerToken(request);
  if (!token) throw unauthorized("Missing or invalid API key.");

  if (options.apiKeyStore) {
    const dbRecord = options.apiKeyStore.getApiKeyByHash(hashApiKey(token));
    if (dbRecord) {
      if (dbRecord.revokedAt) {
        throw unauthorized("Missing or invalid API key.");
      }
      const identity: Identity = {
        subject: dbRecord.subject,
        clientId: dbRecord.clientId,
        mode: "remote",
      };
      touchLastUsedBestEffort(options.apiKeyStore, dbRecord);
      return identity;
    }
  }

  const record = options.envRecords.find((candidate) => timingSafeStringEqual(token, candidate.key));
  if (!record) throw unauthorized("Missing or invalid API key.");
  return {
    subject: record.subject,
    clientId: record.clientId,
    mode: "remote",
  };
}

export function installApiKeyAuth(app: FastifyInstance, optionsOrRecords: ApiKeyAuthOptions | ApiKeyRecord[]): void {
  const options = Array.isArray(optionsOrRecords)
    ? { envRecords: optionsOrRecords }
    : optionsOrRecords;
  if (!options.envRecords.length && !options.apiKeyStore) {
    throw new Error("Remote API mode requires at least one API key record.");
  }
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1")) return;
    if (isAdminPath(request.url)) return;
    request.identity = resolveApiKeyIdentity(request, options);
  });
}

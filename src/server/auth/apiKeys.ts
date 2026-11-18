import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../../config.js";
import type { ApiKeyStore, StoredApiKeyRecord } from "../../pipeline/store.js";
import { timingSafeStringEqual } from "../constantTime.js";
import { forbidden, unauthorized } from "../errors.js";
import { isPublicRouteAllowed, scopeForSubject } from "../scope.js";
import type { Identity } from "../tenancy.js";

export interface ApiKeyRecord {
  key: string;
  clientId: string;
  subject: string;
}

export interface ApiKeyAuthOptions {
  apiKeyStore?: ApiKeyStore;
  envRecords: ApiKeyRecord[];
  /**
   * Public-scope keys are accepted only alongside a matching
   * X-Jantra-Edge-Secret header, and refused entirely while this is empty. Public keys live at the edge and also unlock
   * trust in X-Jantra-Client-IP, so without this a leaked public key lets a
   * caller skip edge rate limits and spoof visitor identity.
   */
  edgeSecret?: string;
}

const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

function isAdminPath(url: string): boolean {
  return url === "/v1/admin" || url.startsWith("/v1/admin/");
}

export function parseApiKeyRecords(raw = config.remoteApiKeysRaw): ApiKeyRecord[] {
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
      const subScope = scopeForSubject(dbRecord.subject);
      const scope = dbRecord.scope ?? subScope.scope;
      const allowedAgentIds = dbRecord.allowedAgents ?? subScope.allowedAgentIds;
      const identity: Identity = {
        subject: dbRecord.subject,
        clientId: dbRecord.clientId,
        mode: "remote",
        scope,
        ...(allowedAgentIds ? { allowedAgentIds } : {}),
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
    ...scopeForSubject(record.subject),
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
    if (request.identity.scope === "public") {
      // Fail closed: with no edge secret configured there is no way to tell an
      // edge request from a direct one, so public keys are refused outright.
      if (!options.edgeSecret) {
        throw forbidden("Public keys are disabled until JANTRA_EDGE_SECRET is configured on the origin.");
      }
      const header = request.headers["x-jantra-edge-secret"];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!timingSafeStringEqual(presented, options.edgeSecret)) {
        throw forbidden("Public requests must come through the Jantra edge.");
      }
    }
    if (
      request.identity.scope === "public" &&
      !isPublicRouteAllowed(request.method, request.url.split("?")[0] ?? "")
    ) {
      throw forbidden("This key is not permitted to call this endpoint.");
    }
  });
}

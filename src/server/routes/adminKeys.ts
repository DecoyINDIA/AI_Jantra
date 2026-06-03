import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import type { ApiKeyMetadata, ApiKeyStore } from "../../pipeline/store.js";
import { hashApiKey } from "../auth/apiKeys.js";
import { timingSafeStringEqual } from "../constantTime.js";
import { notFound, unauthorized } from "../errors.js";
import {
  adminApiKeyParamsSchema,
  createAdminApiKeyBodySchema,
  listAdminApiKeysQuerySchema,
  parseWith,
} from "../schemas.js";

const ADMIN_AUDIT_RUN_ID = "admin";
const API_KEY_PREFIX_CHARS = 16;

interface AdminKeyRouteDeps {
  adminToken: string;
  apiKeyStore: ApiKeyStore;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireAdminToken(request: FastifyRequest, adminToken: string): void {
  const token = headerValue(request.headers["x-jantra-admin-token"]);
  if (!timingSafeStringEqual(token, adminToken)) {
    throw unauthorized("Missing or invalid Jantra admin token.");
  }
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function isAdminPath(url: string): boolean {
  return url === "/v1/admin" || url.startsWith("/v1/admin/");
}

export function generateDeveloperApiKey(): string {
  return `jntr_${randomBytes(32).toString("base64url")}`;
}

function auditKeyCreated(apiKey: ApiKeyMetadata): void {
  new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("key_created", {
    clientId: apiKey.clientId,
    keyId: apiKey.id,
    prefix: apiKey.prefix,
    label: apiKey.label,
    subject: apiKey.subject,
  });
}

function auditKeyRevoked(apiKey: ApiKeyMetadata): void {
  new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("key_revoked", {
    clientId: apiKey.clientId,
    keyId: apiKey.id,
    prefix: apiKey.prefix,
    label: apiKey.label,
    subject: apiKey.subject,
    revokedAt: apiKey.revokedAt,
  });
}

export function registerAdminKeyRoutes(app: FastifyInstance, deps: AdminKeyRouteDeps): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!isAdminPath(request.url)) return;
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
  });

  app.post("/v1/admin/keys", async (request) => {
    const body = parseWith(createAdminApiKeyBodySchema, request.body);
    const key = generateDeveloperApiKey();
    const now = new Date().toISOString();
    const apiKey = deps.apiKeyStore.createApiKey({
      id: randomUUID(),
      keyHash: hashApiKey(key),
      prefix: key.slice(0, API_KEY_PREFIX_CHARS),
      clientId: body.clientId,
      subject: body.subject,
      label: body.label,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    });
    auditKeyCreated(apiKey);
    return { key, apiKey };
  });

  app.get("/v1/admin/keys", async (request) => {
    const query = parseWith(listAdminApiKeysQuerySchema, request.query);
    return {
      items: deps.apiKeyStore.listApiKeys({
        clientId: query.clientId,
        includeRevoked: query.includeRevoked ?? false,
      }),
    };
  });

  app.post("/v1/admin/keys/:id/revoke", async (request) => {
    const params = parseWith(adminApiKeyParamsSchema, request.params);
    const revokedAt = new Date().toISOString();
    const apiKey = deps.apiKeyStore.revokeApiKey(params.id, revokedAt);
    if (!apiKey) throw notFound(`API key ${params.id} was not found.`);
    if (apiKey.revokedAt === revokedAt) auditKeyRevoked(apiKey);
    return { apiKey };
  });
}

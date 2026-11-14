import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import type { ProjectStore } from "../../pipeline/store.js";
import { timingSafeStringEqual } from "../constantTime.js";
import { HttpError, notFound, unauthorized } from "../errors.js";
import {
  adminClientConnectorParamsSchema,
  adminClientParamsSchema,
  parseWith,
  setConnectorCredentialsBodySchema,
  setOpsProfileBodySchema,
} from "../schemas.js";

const ADMIN_AUDIT_RUN_ID = "admin";

interface AdminCredentialsRouteDeps {
  adminToken: string;
  store: ProjectStore;
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

export function registerAdminCredentialRoutes(
  app: FastifyInstance,
  deps: AdminCredentialsRouteDeps,
): void {
  // Connector credentials management
  app.put("/v1/admin/clients/:clientId/credentials/:connector", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientConnectorParamsSchema, request.params);
    const body = parseWith(setConnectorCredentialsBodySchema, request.body);

    if (params.connector === "report-webhook") {
      if (!body.credentials.url || !body.credentials.secret) {
        throw new HttpError(400, "bad_request", "report-webhook credentials require 'url' and 'secret'.");
      }
      try {
        new URL(body.credentials.url);
      } catch {
        throw new HttpError(400, "bad_request", "report-webhook 'url' must be a valid URL.");
      }
    }

    if (!deps.store.setConnectorCredentials) {
      throw new Error("Store does not support connector credentials.");
    }

    deps.store.setConnectorCredentials(params.clientId, params.connector, body.credentials);

    new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId: params.clientId,
      action: "connector_credentials_updated",
      connector: params.connector,
    });

    return { ok: true, clientId: params.clientId, connector: params.connector };
  });

  app.get("/v1/admin/clients/:clientId/credentials/:connector", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientConnectorParamsSchema, request.params);

    if (!deps.store.getConnectorCredentials) {
      throw notFound("Connector credentials not found.");
    }

    const credentials = deps.store.getConnectorCredentials(params.clientId, params.connector);
    if (!credentials) {
      throw notFound(`Credentials for connector "${params.connector}" not found.`);
    }

    return { clientId: params.clientId, connector: params.connector, configured: true };
  });

  app.get("/v1/admin/clients/:clientId/credentials", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientParamsSchema, request.params);

    const connectors = deps.store.listConnectorCredentials
      ? deps.store.listConnectorCredentials(params.clientId)
      : [];

    return { clientId: params.clientId, connectors };
  });

  app.delete("/v1/admin/clients/:clientId/credentials/:connector", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientConnectorParamsSchema, request.params);

    if (!deps.store.deleteConnectorCredentials) {
      return { ok: false };
    }

    const deleted = deps.store.deleteConnectorCredentials(params.clientId, params.connector);
    if (!deleted) {
      throw notFound(`Credentials for connector "${params.connector}" not found.`);
    }

    new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId: params.clientId,
      action: "connector_credentials_deleted",
      connector: params.connector,
    });

    return { ok: true, clientId: params.clientId, connector: params.connector };
  });

  // Ops reporting profile management
  app.put("/v1/admin/clients/:clientId/ops-profile", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientParamsSchema, request.params);
    const body = parseWith(setOpsProfileBodySchema, request.body);

    if (!deps.store.setOpsProfile) {
      throw new Error("Store does not support ops profiles.");
    }

    const now = new Date().toISOString();
    const profile = {
      clientId: params.clientId,
      businessName: body.businessName,
      description: body.description,
      currency: body.currency ?? "USD",
      fiscalCalendar: body.fiscalCalendar ?? "January-December",
      knownEvents: body.knownEvents ?? [],
      kpiSpec: body.kpiSpec,
      binding: body.binding,
      delivery: body.delivery,
      confirmedAt: now,
      confirmedBy: "admin",
      createdAt: now,
      updatedAt: now,
    };

    deps.store.setOpsProfile(profile);

    new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId: params.clientId,
      action: "ops_profile_updated",
      businessName: body.businessName,
    });

    return { ok: true, profile };
  });

  app.get("/v1/admin/clients/:clientId/ops-profile", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientParamsSchema, request.params);

    if (!deps.store.getOpsProfile) {
      throw notFound("Ops profile not found.");
    }

    const profile = deps.store.getOpsProfile(params.clientId);
    if (!profile) {
      throw notFound(`Ops profile for client "${params.clientId}" not found.`);
    }

    return { profile };
  });

  app.delete("/v1/admin/clients/:clientId/ops-profile", async (request, reply) => {
    noStore(reply);
    requireAdminToken(request, deps.adminToken);
    const params = parseWith(adminClientParamsSchema, request.params);

    if (!deps.store.deleteOpsProfile) {
      return { ok: false };
    }

    const deleted = deps.store.deleteOpsProfile(params.clientId);
    if (!deleted) {
      throw notFound(`Ops profile for client "${params.clientId}" not found.`);
    }

    new AuditLogger(ADMIN_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId: params.clientId,
      action: "ops_profile_deleted",
    });

    return { ok: true, clientId: params.clientId };
  });
}

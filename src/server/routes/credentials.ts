import type { FastifyInstance, FastifyReply } from "fastify";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import type { ProjectStore } from "../../pipeline/store.js";
import { forbidden, notFound } from "../errors.js";
import { requestClientId } from "../tenancy.js";
import {
  connectorParamsSchema,
  parseWith,
  setConnectorCredentialsBodySchema,
  setOpsProfileBodySchema,
} from "../schemas.js";

const CREDENTIALS_AUDIT_RUN_ID = "credentials";

interface CredentialsRouteDeps {
  clientId: string;
  store: ProjectStore;
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

export function registerCredentialRoutes(
  app: FastifyInstance,
  deps: CredentialsRouteDeps,
): void {
  app.put("/v1/credentials/:connector", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot manage connector credentials.");
    }

    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(connectorParamsSchema, request.params);
    const body = parseWith(setConnectorCredentialsBodySchema, request.body);

    if (!deps.store.setConnectorCredentials) {
      throw new Error("Store does not support connector credentials.");
    }

    deps.store.setConnectorCredentials(clientId, params.connector, body.credentials);

    new AuditLogger(CREDENTIALS_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId,
      action: "connector_credentials_updated",
      connector: params.connector,
    });

    return { ok: true, clientId, connector: params.connector };
  });

  app.get("/v1/credentials/:connector", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot read connector credentials.");
    }

    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(connectorParamsSchema, request.params);

    if (!deps.store.getConnectorCredentials) {
      throw notFound("Connector credentials not found.");
    }

    const credentials = deps.store.getConnectorCredentials(clientId, params.connector);
    if (!credentials) {
      throw notFound(`Credentials for connector "${params.connector}" not found.`);
    }

    return { clientId, connector: params.connector, credentials };
  });

  app.get("/v1/credentials", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot list connector credentials.");
    }

    const clientId = requestClientId(request, deps.clientId);
    const connectors = deps.store.listConnectorCredentials
      ? deps.store.listConnectorCredentials(clientId)
      : [];

    return { clientId, connectors };
  });

  app.delete("/v1/credentials/:connector", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot delete connector credentials.");
    }

    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(connectorParamsSchema, request.params);

    if (!deps.store.deleteConnectorCredentials) {
      return { ok: false };
    }

    const deleted = deps.store.deleteConnectorCredentials(clientId, params.connector);
    if (!deleted) {
      throw notFound(`Credentials for connector "${params.connector}" not found.`);
    }

    new AuditLogger(CREDENTIALS_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId,
      action: "connector_credentials_deleted",
      connector: params.connector,
    });

    return { ok: true, clientId, connector: params.connector };
  });

  // Tenant-scoped ops profile routes
  app.put("/v1/ops-profile", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot manage ops profiles.");
    }

    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(setOpsProfileBodySchema, request.body);

    if (!deps.store.setOpsProfile) {
      throw new Error("Store does not support ops profiles.");
    }

    const now = new Date().toISOString();
    const profile = {
      clientId,
      businessName: body.businessName,
      description: body.description,
      currency: body.currency ?? "USD",
      fiscalCalendar: body.fiscalCalendar ?? "January-December",
      knownEvents: body.knownEvents ?? [],
      kpiSpec: body.kpiSpec,
      binding: body.binding,
      delivery: body.delivery,
      confirmedAt: now,
      confirmedBy: request.identity?.subject ?? "operator",
      createdAt: now,
      updatedAt: now,
    };

    deps.store.setOpsProfile(profile);

    new AuditLogger(CREDENTIALS_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId,
      action: "ops_profile_updated",
      businessName: body.businessName,
    });

    return { ok: true, profile };
  });

  app.get("/v1/ops-profile", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot read ops profiles.");
    }

    const clientId = requestClientId(request, deps.clientId);

    if (!deps.store.getOpsProfile) {
      throw notFound("Ops profile not found.");
    }

    const profile = deps.store.getOpsProfile(clientId);
    if (!profile) {
      throw notFound(`Ops profile for client "${clientId}" not found.`);
    }

    return { profile };
  });

  app.delete("/v1/ops-profile", async (request, reply) => {
    noStore(reply);
    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot delete ops profiles.");
    }

    const clientId = requestClientId(request, deps.clientId);

    if (!deps.store.deleteOpsProfile) {
      return { ok: false };
    }

    const deleted = deps.store.deleteOpsProfile(clientId);
    if (!deleted) {
      throw notFound(`Ops profile for client "${clientId}" not found.`);
    }

    new AuditLogger(CREDENTIALS_AUDIT_RUN_ID, config.auditDir).record("approval", {
      clientId,
      action: "ops_profile_deleted",
    });

    return { ok: true, clientId };
  });
}

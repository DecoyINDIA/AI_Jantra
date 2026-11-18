import type { FastifyInstance } from "fastify";

import { verifyAuditFile } from "../../audit.js";
import type { ProjectStore } from "../../pipeline/store.js";
import { readAuditEntries } from "../events.js";
import { forbidden, notFound } from "../errors.js";
import { auditVerifyQuerySchema, cursorQuerySchema, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface AuditRouteDeps {
  clientId: string;
  store: ProjectStore;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get("/v1/runs/:runId/audit", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const query = parseWith(cursorQuerySchema, request.query);
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    return readAuditEntries(params.runId, query.cursor, query.limit);
  });

  // Operators check a run's audit chain before trusting or exporting it.
  // Public keys never reach this (scope allowlist), but check again here.
  app.get("/v1/runs/:runId/audit/verify", async (request) => {
    if (request.identity && request.identity.scope !== "full") {
      throw forbidden("Full scope is required to verify audit integrity.");
    }
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const query = parseWith(auditVerifyQuerySchema, request.query);
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    const anchor =
      query.anchorSeq !== undefined && query.anchorHash !== undefined
        ? { seq: query.anchorSeq, hash: query.anchorHash }
        : undefined;
    return { runId: params.runId, anchorChecked: Boolean(anchor), chain: verifyAuditFile(params.runId, undefined, anchor) };
  });
}

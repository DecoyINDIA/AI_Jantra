import type { FastifyInstance } from "fastify";

import { loadProject } from "../../pipeline/store.js";
import { readAuditEntries } from "../events.js";
import { notFound } from "../errors.js";
import { cursorQuerySchema, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface AuditRouteDeps {
  clientId: string;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get("/v1/runs/:runId/audit", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const query = parseWith(cursorQuerySchema, request.query);
    const project = loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    return readAuditEntries(params.runId, query.cursor, query.limit);
  });
}

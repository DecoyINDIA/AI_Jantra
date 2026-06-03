import type { FastifyInstance } from "fastify";

import { loadProject } from "../../pipeline/store.js";
import { readAuditEvents, runEventBus, type RunEvent } from "../events.js";
import { notFound } from "../errors.js";
import { cursorQuerySchema, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface EventRouteDeps {
  clientId: string;
}

function writeSse(raw: NodeJS.WritableStream, event: RunEvent): void {
  raw.write(`id: ${event.cursor}\n`);
  raw.write(`event: ${event.type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const params = parseWith(runParamsSchema, request.params);
    const query = parseWith(cursorQuerySchema, request.query);
    const clientId = requestClientId(request, deps.clientId);
    const project = loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const backfill = readAuditEvents(params.runId, query.cursor, query.limit ?? 100);
    for (const event of backfill.items) writeSse(reply.raw, event);

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    const unsubscribe = runEventBus.subscribe(params.runId, (event) => writeSse(reply.raw, event));
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

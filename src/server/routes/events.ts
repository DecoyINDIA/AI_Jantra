import type { FastifyInstance } from "fastify";

import type { ProjectStore } from "../../pipeline/store.js";
import { readAuditEvents, runEventBus, type RunEvent } from "../events.js";
import { config } from "../../config.js";
import { HttpError, notFound } from "../errors.js";
import { cursorQuerySchema, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface EventRouteDeps {
  clientId: string;
  store: ProjectStore;
}

function writeSse(raw: NodeJS.WritableStream, event: RunEvent): void {
  raw.write(`id: ${event.cursor}\n`);
  raw.write(`event: ${event.type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

// The rate limiter counts requests, not open connections, so streams are
// capped separately: per caller identity and process-wide.
const openStreams = new Map<string, number>();
let openStreamsTotal = 0;

export function openEventStreamCount(): number {
  return openStreamsTotal;
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const params = parseWith(runParamsSchema, request.params);
    const query = parseWith(cursorQuerySchema, request.query);
    const clientId = requestClientId(request, deps.clientId);
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);

    const streamKey = request.identity ? `${request.identity.clientId}|${request.identity.subject}` : "local";
    const mine = openStreams.get(streamKey) ?? 0;
    if (mine >= config.sseMaxPerIdentity || openStreamsTotal >= config.sseMaxTotal) {
      throw new HttpError(429, "too_many_streams", "Too many open event streams. Close one and retry.");
    }
    openStreams.set(streamKey, mine + 1);
    openStreamsTotal++;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // hijack() skips onSend hooks, so repeat the baseline headers here.
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });

    const backfill = readAuditEvents(params.runId, query.cursor, query.limit ?? 100);
    for (const event of backfill.items) writeSse(reply.raw, event);

    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    const unsubscribe = runEventBus.subscribe(params.runId, (event) => {
      if (!closed) writeSse(reply.raw, event);
    });
    // Idempotent: close and error can both fire. Without an error listener a
    // write racing a dead socket raises an unhandled 'error' and can crash the
    // process.
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      const remaining = (openStreams.get(streamKey) ?? 1) - 1;
      if (remaining > 0) openStreams.set(streamKey, remaining);
      else openStreams.delete(streamKey);
      openStreamsTotal = Math.max(0, openStreamsTotal - 1);
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });
}

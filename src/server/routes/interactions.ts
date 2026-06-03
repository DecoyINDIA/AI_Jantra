import type { FastifyInstance } from "fastify";

import { resumeStageInteraction } from "../../pipeline/orchestrator.js";
import { loadProject } from "../../pipeline/store.js";
import { notFound } from "../errors.js";
import { parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";
import { z } from "zod";

const interactionParamsSchema = runParamsSchema.extend({
  interactionId: z.string().min(1),
});

const interactionBodySchema = z.object({
  text: z.string().optional(),
  approved: z.boolean().optional(),
});

interface InteractionRouteDeps {
  clientId: string;
}

export function registerInteractionRoutes(
  app: FastifyInstance,
  deps: InteractionRouteDeps,
): void {
  app.get("/v1/runs/:runId/interactions", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    return {
      interactions: project.interactions.filter(
        (interaction) => interaction.status === "pending",
      ),
    };
  });

  app.post("/v1/runs/:runId/interactions/:interactionId", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(interactionParamsSchema, request.params);
    const body = parseWith(interactionBodySchema, request.body);
    const project = loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    const step = await resumeStageInteraction(project, {
      interactionId: params.interactionId,
      text: body.text,
      approved: body.approved,
    });
    return { run: project, step };
  });
}

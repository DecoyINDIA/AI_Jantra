import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import { resumeStageInteraction } from "../../pipeline/orchestrator.js";
import type { ProjectStore } from "../../pipeline/store.js";
import { notFound } from "../errors.js";
import { PUBLIC_INPUT_MAX_CHARS, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

const interactionParamsSchema = runParamsSchema.extend({
  interactionId: z.string().min(1),
});

const interactionBodySchema = z
  .object({
    text: z.string().min(1).max(PUBLIC_INPUT_MAX_CHARS).optional(),
    approved: z.boolean().optional(),
  })
  .refine((body) => body.text !== undefined || body.approved !== undefined, {
    message: "Interaction response requires text or approval.",
  });

interface InteractionRouteDeps {
  clientId: string;
  store: ProjectStore;
}

export function registerInteractionRoutes(
  app: FastifyInstance,
  deps: InteractionRouteDeps,
): void {
  app.get("/v1/runs/:runId/interactions", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = deps.store.loadProject(clientId, params.runId);
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
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    new AuditLogger(project.id, config.auditDir).record("interaction", {
      clientId: project.clientId,
      projectId: project.id,
      stage: project.currentStage,
      interactionId: params.interactionId,
      textChars: body.text?.length ?? 0,
      approved: body.approved,
      subject: request.identity?.subject,
    });
    const step = await resumeStageInteraction(project, {
      interactionId: params.interactionId,
      text: body.text,
      approved: body.approved,
    });
    deps.store.saveProject(project);
    return { run: project, step };
  });
}

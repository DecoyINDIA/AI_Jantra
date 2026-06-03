import type { FastifyInstance } from "fastify";

import type { ProjectStore } from "../../pipeline/store.js";
import { notFound } from "../errors.js";
import { artifactParamsSchema, parseWith, runParamsSchema } from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface ArtifactRouteDeps {
  clientId: string;
  store: ProjectStore;
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void {
  app.get("/v1/runs/:runId/artifacts/:artifactId", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(artifactParamsSchema, request.params);
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    const artifact = Object.values(project.stages)
      .flatMap((stage) => stage.artifacts)
      .find(
        (candidate) =>
          candidate.kind === params.artifactId ||
          `${candidate.stage}:${candidate.kind}:v${candidate.version}` === params.artifactId,
      );
    if (!artifact) throw notFound(`Artifact ${params.artifactId} was not found.`);
    return { artifact };
  });

  app.get("/v1/runs/:runId/sources", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = deps.store.loadProject(clientId, params.runId);
    if (!project) throw notFound(`Run ${params.runId} was not found.`);
    assertProjectAccess(request.identity, project);
    return { sources: project.sources };
  });
}

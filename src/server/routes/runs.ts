import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AgentRegistry } from "../../agents/registry.js";
import { advanceStage, confirmStage, createProject, rejectStage } from "../../pipeline/orchestrator.js";
import type { ProjectStore } from "../../pipeline/store.js";
import { loadProject, saveProject } from "../../pipeline/store.js";
import { notFound } from "../errors.js";
import {
  createRunBodySchema,
  listRunsQuerySchema,
  parseWith,
  rejectRunBodySchema,
  runParamsSchema,
} from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";

interface RunRouteDeps {
  clientId: string;
  registry: AgentRegistry;
  store: ProjectStore;
}

function loadScopedProject(request: FastifyRequest, clientId: string, runId: string) {
  const project = loadProject(clientId, runId);
  if (!project) throw notFound(`Run ${runId} was not found.`);
  assertProjectAccess(request.identity, project);
  return project;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post("/v1/runs", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createRunBodySchema, request.body);
    const definition = deps.registry.get(body.agentId);
    const project = createProject({
      clientId,
      title: body.title,
      definition,
    });
    if (body.input) {
      project.stages[project.currentStage]?.artifacts.push({
        stage: project.currentStage,
        kind: "initial_input",
        title: "Initial input",
        content: body.input,
        version: 1,
        createdAt: new Date().toISOString(),
      });
      saveProject(project);
    }
    return { run: project };
  });

  app.get("/v1/runs", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const query = parseWith(listRunsQuerySchema, request.query);
    return deps.store.listProjects({
      clientId,
      agentId: query.agentId,
      status: query.status,
      currentStage: query.currentStage,
      cursor: query.cursor,
      limit: query.limit,
    });
  });

  app.get("/v1/runs/:runId", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    return { run: loadScopedProject(request, clientId, params.runId) };
  });

  app.post("/v1/runs/:runId/advance", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadScopedProject(request, clientId, params.runId);
    const step = await advanceStage(project);
    return { run: project, step };
  });

  app.post("/v1/runs/:runId/confirm", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadScopedProject(request, clientId, params.runId);
    const nextStage = confirmStage(project);
    return { run: project, nextStage };
  });

  app.post("/v1/runs/:runId/reject", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const body = parseWith(rejectRunBodySchema, request.body);
    const project = loadScopedProject(request, clientId, params.runId);
    rejectStage(project, body.reason);
    return { run: project };
  });
}

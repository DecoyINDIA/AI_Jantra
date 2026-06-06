import type { FastifyInstance, FastifyRequest } from "fastify";

import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { advanceStage, confirmStage, createProject, rejectStage } from "../../pipeline/orchestrator.js";
import type { ProjectStore } from "../../pipeline/store.js";
import {
  auditClientDailyIdeationBudgetExceeded,
  clientDailyIdeationBudgetStatus,
  PUBLIC_INTAKE_AGENT_ID,
} from "../../runtime/intakeBudget.js";
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

function loadScopedProject(
  request: FastifyRequest,
  store: ProjectStore,
  clientId: string,
  runId: string,
) {
  const project = store.loadProject(clientId, runId);
  if (!project) throw notFound(`Run ${runId} was not found.`);
  assertProjectAccess(request.identity, project);
  return project;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post("/v1/runs", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createRunBodySchema, request.body);
    const definition = deps.registry.get(body.agentId);
    if (definition.id === PUBLIC_INTAKE_AGENT_ID) {
      const budget = clientDailyIdeationBudgetStatus(deps.store, clientId);
      if (budget.exceeded) {
        auditClientDailyIdeationBudgetExceeded(clientId, budget);
        return reply.status(429).send({
          code: "client_daily_ideation_budget_exceeded",
          spend: budget.spend,
          ceiling: budget.ceiling,
          day: budget.day,
        });
      }
    }
    const project = createProject({
      clientId,
      title: body.title,
      definition,
    });
    const audit = new AuditLogger(project.id, config.auditDir);
    audit.record("run_created", {
      clientId: project.clientId,
      projectId: project.id,
      agentId: project.agentId,
      agentVersion: project.agentVersion,
      titleChars: body.title.length,
      initialInputChars: body.input?.length ?? 0,
    });
    deps.store.saveProject(project);
    if (body.input) {
      project.stages[project.currentStage]?.artifacts.push({
        stage: project.currentStage,
        kind: "initial_input",
        title: "Initial input",
        content: body.input,
        version: 1,
        createdAt: new Date().toISOString(),
      });
      deps.store.saveProject(project);
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
    return { run: loadScopedProject(request, deps.store, clientId, params.runId) };
  });

  app.post("/v1/runs/:runId/advance", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadScopedProject(request, deps.store, clientId, params.runId);
    const step = await advanceStage(project, undefined, deps.store);
    deps.store.saveProject(project);
    return { run: project, step };
  });

  app.post("/v1/runs/:runId/confirm", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadScopedProject(request, deps.store, clientId, params.runId);
    const nextStage = confirmStage(project);
    deps.store.saveProject(project);
    return { run: project, nextStage };
  });

  app.post("/v1/runs/:runId/reject", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const body = parseWith(rejectRunBodySchema, request.body);
    const project = loadScopedProject(request, deps.store, clientId, params.runId);
    rejectStage(project, body.reason);
    const audit = new AuditLogger(project.id, config.auditDir);
    audit.record("stage_gate", {
      clientId: project.clientId,
      projectId: project.id,
      stage: project.currentStage,
      status: "rejected",
      reason: body.reason,
    });
    deps.store.saveProject(project);
    return { run: project };
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";

import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import type { AgentRegistry } from "../../agents/registry.js";
import {
  advanceUntilGate,
  confirmStage,
  continueAutonomously,
  createProject,
  rejectStage,
  withRunLock,
} from "../../pipeline/orchestrator.js";
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
          error: {
            code: "client_daily_ideation_budget_exceeded",
            message: "Client daily ideation budget exceeded.",
            details: {
              spend: budget.spend,
              ceiling: budget.ceiling,
              day: budget.day,
            },
          },
        });
      }
    }
    const project = createProject({
      clientId,
      title: body.title,
      definition,
      modelId: body.modelId,
      autonomy: body.autonomy,
    });
    const audit = new AuditLogger(project.id, config.auditDir);
    audit.record("run_created", {
      clientId: project.clientId,
      projectId: project.id,
      agentId: project.agentId,
      agentVersion: project.agentVersion,
      modelId: project.modelId ?? null,
      autonomy: project.autonomy ?? "gated",
      titleChars: body.title.length,
      initialInputChars: body.input?.length ?? 0,
    });
    deps.store.saveProject(project);
    if (body.input) {
      const artifact = {
        stage: project.currentStage,
        kind: "initial_input",
        title: "Initial input",
        content: body.input,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      project.stages[project.currentStage]?.artifacts.push(artifact);
      // Persist the artifact to disk and record it, like every other artifact —
      // otherwise the initial input is the only one with no file or audit trail.
      const path = deps.store.writeArtifactFile(project.clientId, project.id, artifact);
      audit.record("agent_message", {
        clientId: project.clientId,
        projectId: project.id,
        stage: project.currentStage,
        artifactKind: artifact.kind,
        artifactPath: path,
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
    // Serialize per-run: load, drive, and save inside the lock so concurrent
    // /advance calls cannot each run the stage on a stale copy and clobber.
    return withRunLock(params.runId, async () => {
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      const step = await advanceUntilGate(project, undefined, deps.store);
      deps.store.saveProject(project);
      return { run: project, step };
    });
  });

  app.post("/v1/runs/:runId/confirm", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    return withRunLock(params.runId, async () => {
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      const nextStage = confirmStage(project, deps.store);
      // For an autonomous run whose gate was downgraded to human, resume driving
      // the remaining stages once the human has confirmed.
      const step = await continueAutonomously(project, undefined, deps.store);
      deps.store.saveProject(project);
      return { run: project, nextStage, step };
    });
  });

  app.post("/v1/runs/:runId/reject", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const body = parseWith(rejectRunBodySchema, request.body);
    return withRunLock(params.runId, async () => {
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      rejectStage(project, body.reason, deps.store);
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
  });
}

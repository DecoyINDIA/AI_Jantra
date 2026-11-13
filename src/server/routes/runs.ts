import { randomUUID } from "node:crypto";
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
  visitorDailyBudgetStatus,
} from "../../runtime/intakeBudget.js";
import type { Artifact } from "../../pipeline/types.js";
import { visitorKey } from "../visitor.js";
import { forbidden, HttpError, notFound } from "../errors.js";
import { assertAgentAllowed } from "../scope.js";
import {
  createRunBodySchema,
  listRunsQuerySchema,
  parseWith,
  rejectRunBodySchema,
  runJobParamsSchema,
  runParamsSchema,
} from "../schemas.js";
import { assertProjectAccess, requestClientId } from "../tenancy.js";
import { renderClientReadyReport } from "../export/clientReport.js";
import type { JobRecord, JobStore } from "../jobs/types.js";
import type { JobWorker } from "../jobs/worker.js";

interface RunRouteDeps {
  clientId: string;
  registry: AgentRegistry;
  store: ProjectStore;
  jobWorker?: JobWorker;
}

function isAsyncPreferred(request: FastifyRequest): boolean {
  const prefer = request.headers.prefer;
  return typeof prefer === "string" && prefer.toLowerCase().includes("respond-async");
}

function isJobStore(store: unknown): store is JobStore {
  const candidate = store as Partial<JobStore>;
  return (
    typeof candidate?.createJob === "function" &&
    typeof candidate?.getJob === "function" &&
    typeof candidate?.claimNextJob === "function"
  );
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
  assertAgentAllowed(request.identity, project.agentId);
  return project;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post("/v1/runs", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createRunBodySchema, request.body);
    const identity = request.identity;
    if (identity?.scope === "public") {
      assertAgentAllowed(identity, body.agentId);
      if (body.autonomy !== undefined && body.autonomy !== "gated") {
        throw new HttpError(403, "autonomy_not_allowed", "This key cannot change run autonomy.");
      }
      if (body.modelId !== undefined) {
        throw new HttpError(403, "model_pin_not_allowed", "This key cannot select a model.");
      }
    }
    let definition;
    try {
      definition = deps.registry.get(body.agentId);
    } catch {
      throw notFound(`Agent ${body.agentId} was not found.`);
    }
    const vKey = request.identity?.scope === "public" ? visitorKey(request) : undefined;
    if (request.identity?.scope === "public" || definition.id === PUBLIC_INTAKE_AGENT_ID) {
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
      if (vKey) {
        const vBudget = visitorDailyBudgetStatus(deps.store, clientId, vKey);
        if (vBudget.exceeded) {
          return reply.status(429).send({
            error: {
              code: "visitor_daily_budget_exceeded",
              message: "Visitor daily budget exceeded.",
              details: {
                spend: vBudget.spend,
                ceiling: vBudget.ceiling,
                day: vBudget.day,
              },
            },
          });
        }
      }
    }
    const project = createProject({
      clientId,
      title: body.title,
      definition,
      modelId: body.modelId,
      autonomy: body.autonomy,
      visitorKey: vKey,
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

  app.get("/v1/runs/:runId/export", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const project = loadScopedProject(request, deps.store, clientId, params.runId);
    const html = renderClientReadyReport(project);
    reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/v1/runs/:runId/advance", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);

    if (isAsyncPreferred(request)) {
      if (!isJobStore(deps.store)) {
        throw new HttpError(400, "async_not_supported", "Asynchronous execution requires SQLite store.");
      }
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      const job: JobRecord = {
        id: randomUUID(),
        clientId: project.clientId,
        runId: project.id,
        kind: "advance",
        payload: {},
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      deps.store.createJob(job);
      deps.jobWorker?.wake();
      reply.code(202);
      return { run: project, job: { id: job.id, status: "queued" } };
    }

    // Serialize per-run: load, drive, and save inside the lock so concurrent
    // /advance calls cannot each run the stage on a stale copy and clobber.
    return withRunLock(params.runId, async () => {
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      const step = await advanceUntilGate(project, undefined, deps.store);
      deps.store.saveProject(project);
      return { run: project, step };
    });
  });

  app.post("/v1/runs/:runId/confirm", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);
    const body = request.body as { autoContinue?: boolean } | undefined;

    if (isAsyncPreferred(request)) {
      if (!isJobStore(deps.store)) {
        throw new HttpError(400, "async_not_supported", "Asynchronous execution requires SQLite store.");
      }
      const project = loadScopedProject(request, deps.store, clientId, params.runId);
      const job: JobRecord = {
        id: randomUUID(),
        clientId: project.clientId,
        runId: project.id,
        kind: "confirm_continue",
        payload: { autoContinue: body?.autoContinue ?? false },
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      deps.store.createJob(job);
      deps.jobWorker?.wake();
      reply.code(202);
      return { run: project, job: { id: job.id, status: "queued" } };
    }

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

  app.get("/v1/runs/:runId/jobs/:jobId", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runJobParamsSchema, request.params);
    const project = loadScopedProject(request, deps.store, clientId, params.runId);
    if (!isJobStore(deps.store)) {
      throw notFound(`Job ${params.jobId} was not found.`);
    }
    const job = deps.store.getJob(clientId, project.id, params.jobId);
    if (!job) {
      throw notFound(`Job ${params.jobId} was not found.`);
    }
    return {
      job: {
        id: job.id,
        runId: job.runId,
        kind: job.kind,
        status: job.status,
        error: job.error ?? null,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      },
    };
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

  // Promote a completed intake run into a full planning pipeline run.
  // Full scope only: creates a planning-pipeline run with intake pre-confirmed
  // using the source run's idea_summary artifact.
  app.post("/v1/runs/:runId/promote", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(runParamsSchema, request.params);

    if (request.identity?.scope === "public") {
      throw forbidden("Public keys cannot promote runs.");
    }

    const sourceProject = loadScopedProject(request, deps.store, clientId, params.runId);

    const ideaSummary = Object.values(sourceProject.stages)
      .flatMap((s) => s.artifacts)
      .filter((a) => a.kind === "idea_summary")
      .at(-1);

    if (!ideaSummary) {
      throw new HttpError(400, "missing_idea_summary", "Source run does not contain an idea summary.");
    }

    const definition = deps.registry.get("planning-pipeline");
    const newProject = createProject({
      clientId,
      title: sourceProject.title,
      definition,
      autonomy: sourceProject.autonomy ?? "gated",
    });

    const now = new Date().toISOString();
    const copiedArtifact: Artifact = {
      ...ideaSummary,
      stage: "intake",
      version: 1,
      createdAt: now,
    };

    const intakeStage = newProject.stages.intake;
    if (intakeStage) {
      intakeStage.status = "confirmed";
      intakeStage.artifacts = [copiedArtifact];
      intakeStage.updatedAt = now;
    }

    const path = deps.store.writeArtifactFile(newProject.clientId, newProject.id, copiedArtifact);

    newProject.currentStage = "research";
    newProject.updatedAt = now;

    deps.store.saveProject(newProject);

    const audit = new AuditLogger(newProject.id, config.auditDir);
    audit.record("run_created", {
      clientId: newProject.clientId,
      projectId: newProject.id,
      agentId: newProject.agentId,
      agentVersion: newProject.agentVersion,
      modelId: newProject.modelId ?? null,
      autonomy: newProject.autonomy ?? "gated",
      titleChars: newProject.title.length,
      promotedFrom: sourceProject.id,
    });
    audit.record("agent_message", {
      clientId: newProject.clientId,
      projectId: newProject.id,
      stage: "intake",
      artifactKind: copiedArtifact.kind,
      artifactPath: path,
    });
    audit.record("stage_gate", {
      clientId: newProject.clientId,
      projectId: newProject.id,
      stage: "intake",
      status: "confirmed",
      gate: "human",
      autonomy: newProject.autonomy ?? "gated",
    });

    reply.code(201);
    return { run: newProject };
  });
}

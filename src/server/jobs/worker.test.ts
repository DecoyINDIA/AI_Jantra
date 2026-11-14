import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { config } from "../../config.js";
import { createProject } from "../../pipeline/orchestrator.js";
import { SqliteProjectStore } from "../../pipeline/store/sqlite.js";
import { JobWorker } from "./worker.js";
import type { JobRecord } from "./types.js";

describe("JobWorker (T-014)", () => {
  const originalProvider = config.provider;

  before(() => {
    (config as any).provider = "mock";
  });

  after(() => {
    (config as any).provider = originalProvider;
  });

  it("claims and executes an advance job asynchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-job-worker-"));
    const dbPath = join(dir, "jobs.sqlite");
    const store = new SqliteProjectStore(dbPath, { skipImport: true });
    const clientId = "client-jobs-test";

    const worker = new JobWorker({
      store,
      pollIntervalMs: 20,
    });

    try {
      // 1. Create a project
      const project = createProject({
        clientId,
        agentId: "planning-pipeline",
        title: "Async Job Test",
      });
      store.saveProject(project);

      // 2. Queue an advance job
      const job: JobRecord = {
        id: "job-1",
        clientId,
        runId: project.id,
        kind: "advance",
        payload: {},
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      store.createJob(job);

      // 3. Start worker
      worker.start();

      // 4. Poll until job is done
      const deadline = Date.now() + 5000;
      let finalJob = store.getJob(clientId, project.id, "job-1");
      while (Date.now() < deadline && finalJob?.status !== "done") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finalJob = store.getJob(clientId, project.id, "job-1");
      }

      assert.equal(finalJob?.status, "done");
      assert(finalJob?.startedAt, "Expected startedAt timestamp");
      assert(finalJob?.finishedAt, "Expected finishedAt timestamp");

      // Verify the project actually advanced
      const updatedProject = store.loadProject(clientId, project.id);
      assert(updatedProject, "Project must exist");
      const intakeStage = updatedProject.stages.intake;
      assert(intakeStage, "Expected intake stage");
      assert(
        intakeStage.status === "awaiting_input" || intakeStage.status === "awaiting_confirmation",
        `Expected gate status, got ${intakeStage.status}`,
      );
    } finally {
      worker.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requeues running jobs on worker start (crash recovery)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-job-crash-"));
    const dbPath = join(dir, "crash.sqlite");
    const store = new SqliteProjectStore(dbPath, { skipImport: true });
    const clientId = "client-crash-test";

    try {
      const project = createProject({
        clientId,
        agentId: "planning-pipeline",
        title: "Crash Recovery Test",
      });
      store.saveProject(project);

      // Create a job simulated as interrupted mid-run (status: running)
      const job: JobRecord = {
        id: "job-crashed",
        clientId,
        runId: project.id,
        kind: "advance",
        payload: {},
        status: "running",
        attempts: 1,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      store.createJob(job);

      const worker = new JobWorker({
        store,
        pollIntervalMs: 20,
      });

      // Starting worker should requeue running jobs and finish them
      worker.start();

      const deadline = Date.now() + 5000;
      let finalJob = store.getJob(clientId, project.id, "job-crashed");
      while (Date.now() < deadline && finalJob?.status !== "done") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finalJob = store.getJob(clientId, project.id, "job-crashed");
      }

      assert.equal(finalJob?.status, "done");
      assert.equal(finalJob?.attempts, 2, "Attempts should have incremented to 2");

      worker.stop();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks job as failed when run does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-job-fail-"));
    const dbPath = join(dir, "fail.sqlite");
    const store = new SqliteProjectStore(dbPath, { skipImport: true });
    const clientId = "client-fail-test";

    const worker = new JobWorker({
      store,
      pollIntervalMs: 20,
    });

    try {
      const job: JobRecord = {
        id: "job-missing-project",
        clientId,
        runId: "nonexistent-run",
        kind: "advance",
        payload: {},
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      store.createJob(job);

      worker.start();

      const deadline = Date.now() + 5000;
      let finalJob = store.getJob(clientId, "nonexistent-run", "job-missing-project");
      while (Date.now() < deadline && finalJob?.status !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finalJob = store.getJob(clientId, "nonexistent-run", "job-missing-project");
      }

      assert.equal(finalJob?.status, "failed");
      assert(finalJob?.error?.includes("Project nonexistent-run was not found."));
    } finally {
      worker.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

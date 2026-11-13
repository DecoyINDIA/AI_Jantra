import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import {
  advanceUntilGate,
  confirmStage,
  continueAutonomously,
  resumeStageInteraction,
  withRunLock,
} from "../../pipeline/orchestrator.js";
import type { ProjectStore } from "../../pipeline/store.js";
import type { JobRecord, JobStore } from "./types.js";

export interface JobWorkerDeps {
  store: ProjectStore & JobStore;
  pollIntervalMs?: number;
}

export class JobWorker {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private inProgress = false;

  constructor(private readonly deps: JobWorkerDeps) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      this.deps.store.requeueRunningJobs();
    } catch (err) {
      console.warn("Failed to requeue running jobs on worker start:", err);
    }
    void this.loop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  wake(): void {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (!this.isRunning || this.inProgress) return;
    this.inProgress = true;

    try {
      while (this.isRunning) {
        let job: JobRecord | null = null;
        try {
          job = this.deps.store.claimNextJob();
        } catch (err) {
          console.warn("Error claiming next job:", err);
        }

        if (!job) {
          break;
        }

        await this.processJob(job);
      }
    } finally {
      this.inProgress = false;
    }

    const interval = this.deps.pollIntervalMs ?? 1000;
    if (this.isRunning && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.loop();
      }, interval);
    }
  }

  private async processJob(job: JobRecord): Promise<void> {
    const audit = new AuditLogger(job.runId, config.auditDir);
    audit.record("job_started", {
      clientId: job.clientId,
      projectId: job.runId,
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
    });

    try {
      await withRunLock(job.runId, async () => {
        const project = this.deps.store.loadProject(job.clientId, job.runId);
        if (!project) throw new Error(`Project ${job.runId} was not found.`);

        if (job.kind === "advance") {
          await advanceUntilGate(project, undefined, this.deps.store);
          this.deps.store.saveProject(project);
          await continueAutonomously(project, undefined, this.deps.store);
          this.deps.store.saveProject(project);
        } else if (job.kind === "confirm_continue") {
          const payload = job.payload as { autoContinue?: boolean };
          confirmStage(project, this.deps.store);
          this.deps.store.saveProject(project);
          if (payload.autoContinue) {
            await advanceUntilGate(project, undefined, this.deps.store);
            this.deps.store.saveProject(project);
          }
          await continueAutonomously(project, undefined, this.deps.store);
          this.deps.store.saveProject(project);
        } else if (job.kind === "interaction") {
          const payload = job.payload as {
            interactionId: string;
            text?: string;
            approved?: boolean;
          };
          let step = await resumeStageInteraction(
            project,
            {
              interactionId: payload.interactionId,
              text: payload.text,
              approved: payload.approved,
            },
            undefined,
            this.deps.store,
          );
          step = (await continueAutonomously(project, undefined, this.deps.store)) ?? step;
          this.deps.store.saveProject(project);
        }
      });

      this.deps.store.finishJob(job.id);
      audit.record("job_finished", {
        clientId: job.clientId,
        projectId: job.runId,
        jobId: job.id,
        kind: job.kind,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.store.finishJob(job.id, errorMessage);
      audit.record("job_failed", {
        clientId: job.clientId,
        projectId: job.runId,
        jobId: job.id,
        kind: job.kind,
        error: errorMessage,
      });
    }
  }
}

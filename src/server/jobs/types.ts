export type JobKind = "advance" | "confirm_continue" | "interaction";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  clientId: string;
  runId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobView {
  id: string;
  runId: string;
  kind: JobKind;
  status: JobStatus;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobStore {
  createJob(job: JobRecord): JobRecord;
  getJob(clientId: string, runId: string, jobId: string): JobRecord | null;
  claimNextJob(): JobRecord | null;
  finishJob(jobId: string, error?: string | null): void;
  requeueRunningJobs(): number;
}

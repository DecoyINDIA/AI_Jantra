import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { config } from "../../config.js";
import { assertSafePathSegment, defaultStore, type ProjectStore } from "../../pipeline/store.js";
import type { Project } from "../../pipeline/types.js";
import { AuditLogger } from "../../audit.js";
import {
  isRunDeleted,
  markRunDeleted,
  tryAcquireRunLock,
  unmarkRunDeleted,
} from "../../pipeline/orchestrator.js";
import { StageFailedClosedError } from "../../runtime/errors.js";

// Lead capture is intentionally a small, self-contained JSON store rather than
// part of the project ProjectStore: leads are low-volume marketing records with
// a different lifecycle (no stages, no cost, no tenancy beyond the owning user)
// and we do not want to couple them to the planning-pipeline schema.

let atomicSeq = 0;

function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${atomicSeq++}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

function clientLeadDir(clientId: string): string {
  return join(config.leadDir, assertSafePathSegment(clientId, "clientId"));
}

function leadFile(clientId: string, leadId: string): string {
  return join(clientLeadDir(clientId), `${assertSafePathSegment(leadId, "leadId")}.json`);
}

function jsonDeletionRequestsFile(): string {
  return join(config.leadDir, ".deletion_requests.json");
}

function jsonDeletionsLogFile(): string {
  return join(config.leadDir, ".deletions.jsonl");
}

// Arbitrary diagnostics can contain names, ideas, credentials or provider payloads.
// A fixed message is safer than trying to enumerate every possible secret format.
export function sanitizeErrorMessage(_raw: unknown): string {
  return "Lead deletion failed closed. Retry after operator review.";
}

export interface LeadRecord {
  id: string;
  clientId: string;
  /** Verified Logto subject when the visitor was logged in, otherwise null. */
  userSub: string | null;
  name: string;
  email: string;
  phone?: string;
  idea: string;
  source: string;
  runId?: string;
  createdAt: string;
}

export interface LeadDeletionRecord {
  id: string;
  clientId: string;
  leadId: string;
  runId: string | null;
  deletedAt: string;
  action: "delete" | "expire" | "remediated_soft_delete";
}

export type LeadDeletionStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

export type LeadDeletionStep =
  | "init"
  | "shared_run_preserved"
  | "ownership_verified"
  | "project_deleted"
  | "jobs_deleted"
  | "audit_deleted"
  | "lead_deleted"
  | "completed";

export interface LeadDeletionRequest {
  id: string;
  clientId: string;
  leadId: string;
  runId: string | null;
  deleteLinkedRun: boolean;
  status: LeadDeletionStatus;
  step: LeadDeletionStep;
  attempts: number;
  error: string | null;
  action: "delete" | "expire";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const deletionQueueSchema = z.array(z.object({
  id: z.string(),
  clientId: z.string(),
  leadId: z.string(),
  runId: z.string().nullable().optional(),
  deleteLinkedRun: z.boolean().optional().default(false),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]),
  step: z.enum(["init", "shared_run_preserved", "ownership_verified", "project_deleted", "jobs_deleted", "audit_deleted", "lead_deleted", "completed"]).optional().default("init"),
  attempts: z.number().int().nonnegative().optional().default(0),
  error: z.string().nullable().optional(),
  action: z.enum(["delete", "expire"]).optional().default("delete"),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
}));

export interface DeleteLeadOptions {
  deleteLinkedRun?: boolean;
  projectStore?: ProjectStore;
  auditDir?: string;
}

export interface SweepLeadsOptions {
  clientId?: string;
  deleteLinkedRuns?: boolean;
  projectStore?: ProjectStore;
  auditDir?: string;
}

/**
 * Verify run ownership positively before performing any linked deletion (R-003).
 * Fails closed if run ownership evidence (project record, audit file first line)
 * is missing, malformed, or belongs to another client.
 */
export function verifyRunOwnership(
  clientId: string,
  runId: string,
  options?: { projectStore?: ProjectStore; auditDir?: string; db?: Database.Database },
): { ok: true } | { ok: false; error: string } {
  assertSafePathSegment(clientId, "clientId");
  assertSafePathSegment(runId, "runId");

  let projectFound = false;

  // 1. If SQLite database is available, check projects table directly
  if (options?.db) {
    try {
      const row = options.db
        .prepare("select client_id from projects where project_id = ?")
        .get(runId) as { client_id: string } | undefined;
      if (!row) {
        return { ok: false, error: `Run ${runId} was not found in project database.` };
      }
      if (row.client_id !== clientId) {
        return {
          ok: false,
          error: `Run ownership mismatch: run ${runId} belongs to client ${row.client_id}, not ${clientId}.`,
        };
      }
      projectFound = true;
    } catch (err) {
      return {
        ok: false,
        error: `Error querying run project record: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Check projectStore if db was not provided or to ensure store consistency
  if (!projectFound) {
    const projectStore = options?.projectStore ?? defaultStore;
    try {
      const existingProject = projectStore.loadProject(clientId, runId);
      if (!existingProject) {
        return { ok: false, error: `Run ${runId} was not found in project store.` };
      }
      if (existingProject.clientId !== clientId) {
        return {
          ok: false,
          error: `Run ownership mismatch: run ${runId} belongs to client ${existingProject.clientId}, not ${clientId}.`,
        };
      }
      projectFound = true;
    } catch (err) {
      return {
        ok: false,
        error: `Error loading run project from store: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 3. Inspect audit file if it exists: ensure it contains valid JSON with matching clientId
  const auditDir = options?.auditDir ?? config.auditDir;
  const auditFile = join(auditDir, `${runId}.jsonl`);
  if (existsSync(auditFile)) {
    try {
      const content = readFileSync(auditFile, "utf8");
      const firstLine = content.split("\n")[0]?.trim();
      if (!firstLine) {
        return { ok: false, error: `Audit file for run ${runId} is empty or unreadable.` };
      }
      const parsed = JSON.parse(firstLine) as { clientId?: string };
      if (!parsed.clientId) {
        return { ok: false, error: `Audit file for run ${runId} is missing clientId in first record.` };
      }
      if (parsed.clientId !== clientId) {
        return {
          ok: false,
          error: `Audit file ownership mismatch: run ${runId} belongs to client ${parsed.clientId}, not ${clientId}.`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: `Audit file for run ${runId} has malformed ownership evidence: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Verifies that the project record and all its associated linked files
 * (artifacts and sources) still exist on disk before permitting cancellation.
 * If any removal has begun, returns false.
 */
export function verifyProjectAndLinkedFilesExist(
  clientId: string,
  projectId: string,
  options?: { projectStore?: ProjectStore; db?: Database.Database },
): boolean {
  let project: Project | null = null;

  // 1. If SQLite database is provided, check projects table directly
  if (options?.db) {
    try {
      const row = options.db
        .prepare("select project_id, data from projects where client_id = ? and project_id = ?")
        .get(clientId, projectId) as { project_id: string; data?: string } | undefined;
      if (!row) return false;
      if (row.data) {
        try {
          const parsed = JSON.parse(row.data);
          project = parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          // Row exists even if data is not JSON
        }
      }
      if (!project) {
        project = { id: projectId, clientId, stages: {}, sources: [] } as any;
      }
    } catch {
      return false;
    }
  }

  // 2. Check project store loadProject if not already loaded from SQLite db
  const projectStore = options?.projectStore ?? defaultStore;
  if (!project) {
    try {
      project = projectStore.loadProject(clientId, projectId);
      if (!project) return false;
    } catch {
      return false;
    }
  }

  // 3. Resolve baseDir for project files
  const baseDir =
    "baseDir" in projectStore && typeof (projectStore as any).baseDir === "string"
      ? (projectStore as any).baseDir
      : "files" in projectStore &&
          (projectStore as any).files &&
          typeof (projectStore as any).files.baseDir === "string"
        ? (projectStore as any).files.baseDir
        : config.projectDir;

  // If store is purely JsonProjectStore (no SQLite DB), check that the project json file exists
  if (!options?.db && "baseDir" in projectStore) {
    const jsonFile = join(baseDir, clientId, `${projectId}.json`);
    if (!existsSync(jsonFile)) return false;
  }

  // Only the path used by writeArtifactFile proves the recorded artifact is intact.
  for (const stage of Object.values(project?.stages ?? {}) as Array<{ artifacts?: Array<{ stage: string; kind: string; version: number }> }>) {
    for (const artifact of stage.artifacts ?? []) {
      const artifactFileName = `${artifact.stage}-${artifact.kind}-v${artifact.version}.md`;
      const directRunPath = join(baseDir, clientId, projectId, artifactFileName);
      if (!existsSync(directRunPath)) return false;
    }
  }

  // Check that any recorded source files exist on disk
  for (const source of project?.sources ?? []) {
    if (source.contentPath && !existsSync(source.contentPath)) {
      return false;
    }
  }

  // If run has been marked deleted in orchestrator, removal has already progressed
  if (isRunDeleted(projectId)) {
    return false;
  }

  return true;
}

export interface LeadStore {
  createLead(record: LeadRecord): LeadRecord;
  getLead?(clientId: string, id: string): LeadRecord | null;
  listLeads(clientId: string): LeadRecord[];
  listLeadsByUser(clientId: string, userSub: string): LeadRecord[];
  deleteLead?(clientId: string, id: string, options?: DeleteLeadOptions): boolean;
  sweepExpiredLeads?(retentionDays: number, options?: SweepLeadsOptions): number;
  remediateSoftDeletedLeads?(): number;
  getDeletionRecord?(clientId: string, leadId: string): LeadDeletionRecord | null;
  listDeletionRecords?(clientId: string): LeadDeletionRecord[];
  getDeletionRequest?(id: string): LeadDeletionRequest | null;
  listDeletionRequests?(clientId?: string, status?: LeadDeletionStatus): LeadDeletionRequest[];
  cancelDeletionRequest?(id: string, options?: { projectStore?: ProjectStore; auditDir?: string }): boolean;
  retryDeletionRequest?(
    id: string,
    options?: { projectStore?: ProjectStore; auditDir?: string; force?: boolean },
  ): boolean;
  processPendingDeletionRequests?(options?: { projectStore?: ProjectStore; auditDir?: string }): {
    processed: number;
    succeeded: number;
    failed: number;
  };
  retryFailedDeletionRequests?(options?: {
    projectStore?: ProjectStore;
    auditDir?: string;
    maxAttempts?: number;
    force?: boolean;
  }): {
    processed: number;
    succeeded: number;
    failed: number;
  };
}

interface LeadRow {
  id: string;
  client_id: string;
  user_sub: string | null;
  name: string;
  email: string;
  phone: string | null;
  idea: string;
  source: string;
  run_id: string | null;
  created_at: string;
  deleted_at: string | null;
}

function toLeadRecord(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    userSub: row.user_sub,
    name: row.name,
    email: row.email,
    phone: row.phone ?? undefined,
    idea: row.idea,
    source: row.source,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at,
  };
}

interface DeletionRecordRow {
  id: string;
  client_id: string;
  lead_id: string;
  run_id: string | null;
  deleted_at: string;
  action: string;
}

function toDeletionRecord(row: DeletionRecordRow): LeadDeletionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    leadId: row.lead_id,
    runId: row.run_id,
    deletedAt: row.deleted_at,
    action: row.action as LeadDeletionRecord["action"],
  };
}

interface DeletionRequestRow {
  id: string;
  client_id: string;
  lead_id: string;
  run_id: string | null;
  delete_linked_run: number;
  status: string;
  step?: string;
  attempts: number;
  error: string | null;
  action: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function toDeletionRequest(row: DeletionRequestRow): LeadDeletionRequest {
  return {
    id: row.id,
    clientId: row.client_id,
    leadId: row.lead_id,
    runId: row.run_id,
    deleteLinkedRun: Boolean(row.delete_linked_run),
    status: row.status as LeadDeletionStatus,
    step: (row.step as LeadDeletionStep) || "init",
    attempts: row.attempts,
    error: row.error ? sanitizeErrorMessage(row.error) : null,
    action: row.action as "delete" | "expire",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface SqliteLeadStoreOptions {
  autoRetryFailed?: boolean;
  maxAttempts?: number;
  projectStore?: ProjectStore;
  auditDir?: string;
}

export class SqliteLeadStore implements LeadStore {
  private projectStore?: ProjectStore;

  constructor(
    private readonly db: Database.Database,
    options?: SqliteLeadStoreOptions,
  ) {
    this.projectStore = options?.projectStore;
    this.remediateSoftDeletedLeads();
    this.processPendingDeletionRequests();
    if (options?.autoRetryFailed !== false) {
      this.retryFailedDeletionRequests({ maxAttempts: options?.maxAttempts ?? 5 });
    }
  }

  setProjectStore(projectStore: ProjectStore): void {
    this.projectStore = projectStore;
  }

  createLead(record: LeadRecord): LeadRecord {
    this.db
      .prepare(
        `insert into leads (
          id, client_id, user_sub, name, email, phone, idea, source, run_id, created_at, deleted_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
      )
      .run(
        record.id,
        record.clientId,
        record.userSub ?? null,
        record.name,
        record.email,
        record.phone ?? null,
        record.idea,
        record.source,
        record.runId ?? null,
        record.createdAt,
      );
    return record;
  }

  listLeads(clientId: string): LeadRecord[] {
    const rows = this.db
      .prepare(
        "select * from leads where client_id = ? and deleted_at is null order by created_at desc",
      )
      .all(clientId) as LeadRow[];
    return rows.map(toLeadRecord);
  }

  listLeadsByUser(clientId: string, userSub: string): LeadRecord[] {
    const rows = this.db
      .prepare(
        "select * from leads where client_id = ? and user_sub = ? and deleted_at is null order by created_at desc",
      )
      .all(clientId, userSub) as LeadRow[];
    return rows.map(toLeadRecord);
  }

  getLead(clientId: string, id: string): LeadRecord | null {
    const row = this.db
      .prepare(
        "select * from leads where client_id = ? and id = ? and deleted_at is null",
      )
      .get(clientId, id) as LeadRow | undefined;
    return row ? toLeadRecord(row) : null;
  }

  /**
   * Remediate pre-existing soft-deleted leads by migrating them to lead_deletions
   * and permanently removing their personal data fields / rows from leads (R-001).
   * Surfaces failures and validates that zero soft-deleted rows remain (Finding 5).
   */
  remediateSoftDeletedLeads(): number {
    const tableInfo = this.db.prepare("pragma table_info(leads)").all() as Array<{ name: string }>;
    const hasDeletedAt = tableInfo.some((col) => col.name.toLowerCase() === "deleted_at");
    if (!hasDeletedAt) return 0;

    const softDeleted = this.db
      .prepare("select id, client_id, run_id, deleted_at from leads where deleted_at is not null")
      .all() as Array<{ id: string; client_id: string; run_id: string | null; deleted_at: string }>;

    if (softDeleted.length === 0) return 0;

    const insertRecord = this.db.prepare(
      "insert or ignore into lead_deletions (id, client_id, lead_id, run_id, deleted_at, action) values (?, ?, ?, ?, ?, ?)",
    );
    const deleteLeadRow = this.db.prepare("delete from leads where id = ?");

    const runTx = this.db.transaction(() => {
      for (const row of softDeleted) {
        insertRecord.run(
          randomUUID(),
          row.client_id,
          row.id,
          row.run_id,
          row.deleted_at || new Date().toISOString(),
          "remediated_soft_delete",
        );
        deleteLeadRow.run(row.id);
      }
    });
    runTx();

    const remaining = this.db
      .prepare("select count(*) as count from leads where deleted_at is not null")
      .get() as { count: number };
    if (remaining.count > 0) {
      throw new StageFailedClosedError(
        `Startup remediation failed: ${remaining.count} soft-deleted leads still remain with personal data.`,
      );
    }
    return softDeleted.length;
  }

  getDeletionRecord(clientId: string, leadId: string): LeadDeletionRecord | null {
    try {
      const row = this.db
        .prepare("select * from lead_deletions where client_id = ? and lead_id = ?")
        .get(clientId, leadId) as DeletionRecordRow | undefined;
      return row ? toDeletionRecord(row) : null;
    } catch {
      return null;
    }
  }

  listDeletionRecords(clientId: string): LeadDeletionRecord[] {
    try {
      const rows = this.db
        .prepare("select * from lead_deletions where client_id = ? order by deleted_at desc")
        .all(clientId) as DeletionRecordRow[];
      return rows.map(toDeletionRecord);
    } catch {
      return [];
    }
  }

  getDeletionRequest(id: string): LeadDeletionRequest | null {
    try {
      const row = this.db
        .prepare("select * from lead_deletion_requests where id = ?")
        .get(id) as DeletionRequestRow | undefined;
      return row ? toDeletionRequest(row) : null;
    } catch {
      return null;
    }
  }

  listDeletionRequests(clientId?: string, status?: LeadDeletionStatus): LeadDeletionRequest[] {
    try {
      let query = "select * from lead_deletion_requests where 1=1";
      const params: unknown[] = [];
      if (clientId) {
        query += " and client_id = ?";
        params.push(clientId);
      }
      if (status) {
        query += " and status = ?";
        params.push(status);
      }
      query += " order by created_at desc";
      const rows = this.db.prepare(query).all(...params) as DeletionRequestRow[];
      return rows.map(toDeletionRequest);
    } catch {
      return [];
    }
  }

  private createDeletionRequest(req: LeadDeletionRequest): void {
    this.db
      .prepare(
        `insert into lead_deletion_requests (
          id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.clientId,
        req.leadId,
        req.runId,
        req.deleteLinkedRun ? 1 : 0,
        req.status,
        req.step ?? "init",
        req.attempts,
        req.error ? sanitizeErrorMessage(req.error) : null,
        req.action,
        req.createdAt,
        req.updatedAt,
        req.completedAt,
      );
  }

  private updateDeletionRequestProgress(
    id: string,
    status: LeadDeletionStatus,
    step: LeadDeletionStep,
    attempts: number,
    error?: string | null,
    completedAt?: string | null,
  ): void {
    const now = new Date().toISOString();
    const sanitizedError = error ? sanitizeErrorMessage(error) : null;
    this.db
      .prepare(
        `update lead_deletion_requests set
          status = ?, step = ?, attempts = ?, error = ?, updated_at = ?, completed_at = coalesce(?, completed_at)
        where id = ?`,
      )
      .run(status, step, attempts, sanitizedError, now, completedAt ?? null, id);
  }

  private executeDeletionRequest(
    requestId: string,
    options?: { projectStore?: ProjectStore; auditDir?: string },
  ): boolean {
    const req = this.getDeletionRequest(requestId);
    if (!req) return false;

    if (req.status === "completed" || req.step === "completed") {
      return true;
    }

    const effectiveProjectStore = options?.projectStore ?? this.projectStore ?? defaultStore;
    let currentStep: LeadDeletionStep = req.step || "init";
    const nextAttempts = req.attempts + 1;
    this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts, null);

    const needsLinkedRun = req.deleteLinkedRun && Boolean(req.runId);
    let releaseRun: (() => void) | null = null;

    try {
      if (needsLinkedRun && currentStep !== "init" && currentStep !== "shared_run_preserved") {
        releaseRun = tryAcquireRunLock(req.runId!, true);
        if (!releaseRun) throw new Error("Run has active or queued operations.");
        if (
          currentStep === "project_deleted" ||
          currentStep === "jobs_deleted" ||
          currentStep === "audit_deleted" ||
          currentStep === "lead_deleted"
        ) {
          markRunDeleted(req.runId!);
        }
      }
      if (needsLinkedRun) {
        const runId = req.runId!;

        // Step 1: Pre-checks and Ownership Verification
        if (currentStep === "init") {
          // Check for other active leads sharing this runId
          const otherLead = this.db
            .prepare("select id from leads where run_id = ? and id != ? and deleted_at is null limit 1")
            .get(runId, req.leadId);

          if (otherLead) {
            currentStep = "shared_run_preserved";
            this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts);
          } else {
            const ownership = verifyRunOwnership(req.clientId, runId, {
              projectStore: effectiveProjectStore,
              auditDir: options?.auditDir ?? config.auditDir,
              db: this.db,
            });

            if (!ownership.ok) {
              this.updateDeletionRequestProgress(req.id, "failed", currentStep, nextAttempts, ownership.error);
              return false;
            }

            const activeJob = this.db
              .prepare(
                "select id, status from jobs where run_id = ? and status in ('queued', 'running') limit 1",
              )
              .get(runId) as { id: string; status: string } | undefined;
            if (activeJob) {
              this.updateDeletionRequestProgress(
                req.id,
                "failed",
                currentStep,
                nextAttempts,
                `Cannot delete run ${runId}: job ${activeJob.id} is currently ${activeJob.status}.`,
              );
              return false;
            }

            releaseRun = tryAcquireRunLock(runId);
            if (!releaseRun) {
              this.updateDeletionRequestProgress(
                req.id,
                "failed",
                currentStep,
                nextAttempts,
                `Run ${runId} is currently locked by active execution or queued operations.`,
              );
              return false;
            }

            currentStep = "ownership_verified";
            this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts);
          }
        }

        // Step 2: Delete project from projectStore and SQLite projects table
        if (currentStep === "ownership_verified") {
          const projectStore = effectiveProjectStore;
          if (!projectStore.deleteProject) throw new Error("Project deletion is unsupported.");
          projectStore.deleteProject(req.clientId, runId);
          this.db
            .prepare("delete from projects where client_id = ? and project_id = ?")
            .run(req.clientId, runId);

          this.updateDeletionRequestProgress(req.id, "processing", "project_deleted", nextAttempts);
          currentStep = "project_deleted";
          markRunDeleted(runId);
        }

        // Step 3: Delete jobs associated with the run
        if (currentStep === "project_deleted") {
          this.db
            .prepare("delete from jobs where client_id = ? and run_id = ?")
            .run(req.clientId, runId);

          currentStep = "jobs_deleted";
          this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts);
        }

        // Step 4: Delete run audit log file and mark run deleted
        if (currentStep === "jobs_deleted") {
          const auditDir = options?.auditDir ?? config.auditDir;
          const auditFile = join(auditDir, `${runId}.jsonl`);
          if (existsSync(auditFile)) {
            rmSync(auditFile, { force: true });
          }
          markRunDeleted(runId);

          currentStep = "audit_deleted";
          this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts);
        }
      }

      // Step 5: Delete lead personal data and create deletion audit record in single transaction (R-001)
      if ((currentStep === "audit_deleted" || currentStep === "shared_run_preserved") || (!needsLinkedRun && currentStep === "init")) {
        const nowIso = new Date().toISOString();
        const runTx = this.db.transaction(() => {
          this.db
            .prepare(
              `insert or ignore into lead_deletions (
                id, client_id, lead_id, run_id, deleted_at, action
              ) values (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              req.clientId,
              req.leadId,
              req.runId ?? null,
              nowIso,
              req.action,
            );

          this.db
            .prepare("delete from leads where client_id = ? and id = ?")
            .run(req.clientId, req.leadId);
        });
        runTx();

        currentStep = "lead_deleted";
        this.updateDeletionRequestProgress(req.id, "processing", currentStep, nextAttempts);
      }

      // Step 6: System audit log (non-personal metadata only) and mark request completed
      if (currentStep === "lead_deleted") {
        const auditDir = options?.auditDir ?? config.auditDir;
        const audit = new AuditLogger("system", auditDir);
        audit.record("lead_deleted", {
          clientId: req.clientId,
          leadId: req.leadId,
          runId: req.runId ?? null,
          action: req.action,
        });

        currentStep = "completed";
        this.updateDeletionRequestProgress(
          req.id,
          "completed",
          currentStep,
          nextAttempts,
          null,
          new Date().toISOString(),
        );
        return true;
      }

      return true;
    } catch (err) {
      const errorMsg = sanitizeErrorMessage(err);
      this.updateDeletionRequestProgress(req.id, "failed", currentStep, nextAttempts, errorMsg);
      if (req.runId && (currentStep === "init" || currentStep === "ownership_verified")) {
        const projectStillExists = this.db
          ? !!this.db.prepare("select project_id from projects where client_id = ? and project_id = ?").get(req.clientId, req.runId)
          : !!effectiveProjectStore.loadProject(req.clientId, req.runId);
        if (projectStillExists) {
          unmarkRunDeleted(req.runId);
        } else {
          markRunDeleted(req.runId);
        }
      }
      return false;
    } finally {
      releaseRun?.();
    }
  }

  deleteLead(clientId: string, id: string, options?: DeleteLeadOptions): boolean {
    const existing = this.getLead(clientId, id);
    if (!existing) return false;

    const shouldDeleteLinkedRun =
      options?.deleteLinkedRun ?? config.leadDeleteLinkedRuns;

    const requestId = randomUUID();
    const now = new Date().toISOString();
    this.createDeletionRequest({
      id: requestId,
      clientId,
      leadId: id,
      runId: existing.runId ?? null,
      deleteLinkedRun: shouldDeleteLinkedRun,
      status: "pending",
      step: "init",
      attempts: 0,
      error: null,
      action: "delete",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    return this.executeDeletionRequest(requestId, options);
  }

  sweepExpiredLeads(retentionDays: number, options?: SweepLeadsOptions): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    let query = "select id, client_id, run_id from leads where created_at < ? and deleted_at is null";
    const params: unknown[] = [cutoff];

    // R-002: Tenant-safe sweep: when options.clientId is provided, sweep only that tenant
    if (options?.clientId) {
      query += " and client_id = ?";
      params.push(options.clientId);
    }

    const expiredRows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      client_id: string;
      run_id: string | null;
    }>;

    if (expiredRows.length === 0) return 0;

    const shouldDeleteLinkedRuns =
      options?.deleteLinkedRuns ?? config.leadDeleteLinkedRuns;

    let sweptCount = 0;
    for (const row of expiredRows) {
      const requestId = randomUUID();
      const now = new Date().toISOString();
      this.createDeletionRequest({
        id: requestId,
        clientId: row.client_id,
        leadId: row.id,
        runId: row.run_id ?? null,
        deleteLinkedRun: shouldDeleteLinkedRuns,
        status: "pending",
        step: "init",
        attempts: 0,
        error: null,
        action: "expire",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });

      const success = this.executeDeletionRequest(requestId, {
        projectStore: options?.projectStore,
        auditDir: options?.auditDir,
      });

      if (success) {
        sweptCount++;
      }
    }

    return sweptCount;
  }

  processPendingDeletionRequests(options?: { projectStore?: ProjectStore; auditDir?: string }): {
    processed: number;
    succeeded: number;
    failed: number;
  } {
    try {
      const rows = this.db
        .prepare("select id from lead_deletion_requests where status in ('pending', 'processing')")
        .all() as Array<{ id: string }>;

      let succeeded = 0;
      let failed = 0;
      for (const row of rows) {
        const ok = this.executeDeletionRequest(row.id, {
          projectStore: options?.projectStore ?? this.projectStore,
          auditDir: options?.auditDir,
        });
        if (ok) succeeded++;
        else failed++;
      }
      return { processed: rows.length, succeeded, failed };
    } catch {
      throw new StageFailedClosedError("Lead deletion recovery could not read or update its queue.");
    }
  }

  retryFailedDeletionRequests(options?: {
    projectStore?: ProjectStore;
    auditDir?: string;
    maxAttempts?: number;
    force?: boolean;
  }): {
    processed: number;
    succeeded: number;
    failed: number;
  } {
    try {
      const maxAttempts = options?.maxAttempts ?? 5;
      const query = options?.force
        ? "select id from lead_deletion_requests where status = 'failed'"
        : "select id from lead_deletion_requests where status = 'failed' and attempts < ?";
      const rows = (options?.force
        ? this.db.prepare(query).all()
        : this.db.prepare(query).all(maxAttempts)) as Array<{ id: string }>;

      let succeeded = 0;
      let failed = 0;
      for (const row of rows) {
        const ok = this.executeDeletionRequest(row.id, {
          projectStore: options?.projectStore ?? this.projectStore,
          auditDir: options?.auditDir,
        });
        if (ok) succeeded++;
        else failed++;
      }
      return { processed: rows.length, succeeded, failed };
    } catch {
      throw new StageFailedClosedError("Lead deletion recovery could not read or update its queue.");
    }
  }

  cancelDeletionRequest(
    id: string,
    options?: { projectStore?: ProjectStore; auditDir?: string },
  ): boolean {
    const req = this.getDeletionRequest(id);
    if (!req) return false;
    if (req.status === "completed" || req.status === "cancelled") return false;
    if (
      req.step === "project_deleted" ||
      req.step === "jobs_deleted" ||
      req.step === "audit_deleted" ||
      req.step === "lead_deleted" ||
      req.step === "completed"
    ) {
      return false;
    }

    // Verify lead still exists before cancelling
    const lead = this.getLead(req.clientId, req.leadId);
    if (!lead) return false;

    // If linked run deletion was requested, verify the project and linked files still exist
    if (req.deleteLinkedRun && req.runId) {
      const effectiveProjectStore = options?.projectStore ?? this.projectStore ?? defaultStore;
      const intact = verifyProjectAndLinkedFilesExist(req.clientId, req.runId, {
        projectStore: effectiveProjectStore,
        db: this.db,
      });
      if (!intact) {
        markRunDeleted(req.runId);
        return false;
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "update lead_deletion_requests set status = 'cancelled', updated_at = ? where id = ?",
      )
      .run(now, id);
    if (req.runId) {
      unmarkRunDeleted(req.runId);
    }
    return true;
  }

  retryDeletionRequest(
    id: string,
    options?: { projectStore?: ProjectStore; auditDir?: string; force?: boolean },
  ): boolean {
    const req = this.getDeletionRequest(id);
    if (!req) return false;
    if (req.status === "completed") return true;
    if (options?.force || req.attempts >= 5) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          "update lead_deletion_requests set status = 'pending', attempts = 0, error = null, updated_at = ? where id = ?",
        )
        .run(now, id);
    }
    return this.executeDeletionRequest(id, {
      projectStore: options?.projectStore ?? this.projectStore,
      auditDir: options?.auditDir,
    });
  }
}

export class JsonLeadStore implements LeadStore {
  private projectStore?: ProjectStore;

  constructor(options?: { autoRetryFailed?: boolean; maxAttempts?: number; projectStore?: ProjectStore }) {
    this.projectStore = options?.projectStore;
    this.processPendingDeletionRequests();
    if (options?.autoRetryFailed !== false) {
      this.retryFailedDeletionRequests({ maxAttempts: options?.maxAttempts ?? 5 });
    }
  }

  setProjectStore(projectStore: ProjectStore): void {
    this.projectStore = projectStore;
  }

  createLead(record: LeadRecord): LeadRecord {
    mkdirSync(clientLeadDir(record.clientId), { recursive: true });
    atomicWriteFileSync(
      leadFile(record.clientId, record.id),
      JSON.stringify(record, null, 2),
    );
    return record;
  }

  getLead(clientId: string, id: string): LeadRecord | null {
    const file = leadFile(clientId, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as LeadRecord;
    } catch {
      return null;
    }
  }

  private readDeletionRequests(): LeadDeletionRequest[] {
    const file = jsonDeletionRequestsFile();
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf8");
    if (!content.trim()) {
      throw new StageFailedClosedError(
        `Lead deletion queue file ${file} is corrupt (empty file). Original file preserved; operator repair required.`,
      );
    }
    try {
      const parsed = JSON.parse(content);
      return deletionQueueSchema.parse(parsed) as LeadDeletionRequest[];
    } catch (err) {
      throw new StageFailedClosedError(
        `Lead deletion queue file ${file} is corrupt or unreadable. Original file preserved; operator repair required.`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private writeDeletionRequests(requests: LeadDeletionRequest[]): void {
    const file = jsonDeletionRequestsFile();
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8");
      if (existing.trim()) {
        try {
          const parsed = JSON.parse(existing);
          deletionQueueSchema.parse(parsed);
        } catch (err) {
          const corruptBackup = `${file}.corrupt.${Date.now()}`;
          try {
            writeFileSync(corruptBackup, existing, "utf8");
          } catch {}
          throw new StageFailedClosedError(
            `Refusing to overwrite corrupted deletion queue ${file}. Preserved copy to ${corruptBackup}.`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    }

    deletionQueueSchema.parse(requests);
    mkdirSync(config.leadDir, { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(requests, null, 2));
  }

  getDeletionRequest(id: string): LeadDeletionRequest | null {
    const requests = this.readDeletionRequests();
    const req = requests.find((r) => r.id === id);
    return req ? { ...req, error: req.error ? sanitizeErrorMessage(req.error) : null } : null;
  }

  listDeletionRequests(clientId?: string, status?: LeadDeletionStatus): LeadDeletionRequest[] {
    let requests = this.readDeletionRequests();
    if (clientId) {
      requests = requests.filter((r) => r.clientId === clientId);
    }
    if (status) {
      requests = requests.filter((r) => r.status === status);
    }
    return requests.map((req) => ({ ...req, error: req.error ? sanitizeErrorMessage(req.error) : null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getDeletionRecord(clientId: string, leadId: string): LeadDeletionRecord | null {
    const file = jsonDeletionsLogFile();
    if (!existsSync(file)) return null;
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as LeadDeletionRecord;
        if (record.clientId === clientId && record.leadId === leadId) {
          return record;
        }
      }
    } catch {}
    return null;
  }

  listDeletionRecords(clientId: string): LeadDeletionRecord[] {
    const file = jsonDeletionsLogFile();
    if (!existsSync(file)) return [];
    const results: LeadDeletionRecord[] = [];
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as LeadDeletionRecord;
        if (record.clientId === clientId) {
          results.push(record);
        }
      }
    } catch {}
    return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  private executeDeletionRequest(
    requestId: string,
    options?: { projectStore?: ProjectStore; auditDir?: string },
  ): boolean {
    const requests = this.readDeletionRequests();
    const idx = requests.findIndex((r) => r.id === requestId);
    if (idx === -1) return false;

    const req = requests[idx];
    if (!req) return false;

    if (req.status === "completed" || req.step === "completed") {
      return true;
    }

    let currentStep: LeadDeletionStep = req.step || "init";
    const nextAttempts = req.attempts + 1;
    req.status = "processing";
    req.step = currentStep;
    req.attempts = nextAttempts;
    req.error = null;
    req.updatedAt = new Date().toISOString();
    this.writeDeletionRequests(requests);

    const effectiveProjectStore = options?.projectStore ?? this.projectStore ?? defaultStore;
    const needsLinkedRun = req.deleteLinkedRun && Boolean(req.runId);
    let releaseRun: (() => void) | null = null;

    try {
      if (needsLinkedRun && currentStep !== "init" && currentStep !== "shared_run_preserved") {
        releaseRun = tryAcquireRunLock(req.runId!, true);
        if (!releaseRun) throw new Error("Run has active or queued operations.");
        if (
          currentStep === "project_deleted" ||
          currentStep === "jobs_deleted" ||
          currentStep === "audit_deleted" ||
          currentStep === "lead_deleted"
        ) {
          markRunDeleted(req.runId!);
        }
      }
      if (needsLinkedRun) {
        const runId = req.runId!;

        // Step 1: Pre-checks and Ownership Verification
        if (currentStep === "init") {
          let otherLeadExists = false;
          const dir = clientLeadDir(req.clientId);
          if (existsSync(dir)) {
            for (const f of readdirSync(dir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const other = JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadRecord;
                if (other && other.id !== req.leadId && other.runId === runId) {
                  otherLeadExists = true;
                  break;
                }
              } catch {}
            }
          }

          if (otherLeadExists) {
            currentStep = "shared_run_preserved";
            req.step = currentStep;
            req.updatedAt = new Date().toISOString();
            this.writeDeletionRequests(requests);
          } else {
            const ownership = verifyRunOwnership(req.clientId, runId, {
              projectStore: effectiveProjectStore,
              auditDir: options?.auditDir ?? config.auditDir,
            });

            if (!ownership.ok) {
              req.status = "failed";
              req.step = currentStep;
              req.error = sanitizeErrorMessage(ownership.error);
              req.updatedAt = new Date().toISOString();
              this.writeDeletionRequests(requests);
              return false;
            }

            releaseRun = tryAcquireRunLock(runId);
            if (!releaseRun) {
              req.status = "failed";
              req.step = currentStep;
              req.error = sanitizeErrorMessage(
                `Run ${runId} is currently locked by active execution or queued operations.`,
              );
              req.updatedAt = new Date().toISOString();
              this.writeDeletionRequests(requests);
              return false;
            }

            currentStep = "ownership_verified";
            req.step = currentStep;
            req.updatedAt = new Date().toISOString();
            this.writeDeletionRequests(requests);
          }
        }

        // Step 2: Delete project
        if (currentStep === "ownership_verified") {
          const projectStore = effectiveProjectStore;
          if (!projectStore.deleteProject) throw new Error("Project deletion is unsupported.");
          projectStore.deleteProject(req.clientId, runId);

          currentStep = "project_deleted";
          req.step = currentStep;
          req.updatedAt = new Date().toISOString();
          this.writeDeletionRequests(requests);
          markRunDeleted(runId);
        }

        // Step 3: Jobs (no-op in json store)
        if (currentStep === "project_deleted") {
          currentStep = "jobs_deleted";
          req.step = currentStep;
          req.updatedAt = new Date().toISOString();
          this.writeDeletionRequests(requests);
        }

        // Step 4: Delete audit file
        if (currentStep === "jobs_deleted") {
          const auditDir = options?.auditDir ?? config.auditDir;
          const auditFile = join(auditDir, `${runId}.jsonl`);
          if (existsSync(auditFile)) {
            rmSync(auditFile, { force: true });
          }
          markRunDeleted(runId);

          currentStep = "audit_deleted";
          req.step = currentStep;
          req.updatedAt = new Date().toISOString();
          this.writeDeletionRequests(requests);
        }
      }

      // Step 5: Delete lead file and append to deletions log
      if ((currentStep === "audit_deleted" || currentStep === "shared_run_preserved") || (!needsLinkedRun && currentStep === "init")) {
        const nowIso = new Date().toISOString();
        const deletionRecord: LeadDeletionRecord = {
          id: randomUUID(),
          clientId: req.clientId,
          leadId: req.leadId,
          runId: req.runId,
          deletedAt: nowIso,
          action: req.action,
        };

        if (!existsSync(config.leadDir)) {
          mkdirSync(config.leadDir, { recursive: true });
        }
        if (!this.getDeletionRecord(req.clientId, req.leadId)) {
          appendFileSync(jsonDeletionsLogFile(), JSON.stringify(deletionRecord) + "\n", "utf8");
        }
        rmSync(leadFile(req.clientId, req.leadId), { force: true });

        currentStep = "lead_deleted";
        req.step = currentStep;
        req.updatedAt = new Date().toISOString();
        this.writeDeletionRequests(requests);
      }

      // Step 6: System audit log and mark completed
      if (currentStep === "lead_deleted") {
        const auditDir = options?.auditDir ?? config.auditDir;
        const audit = new AuditLogger("system", auditDir);
        audit.record("lead_deleted", {
          clientId: req.clientId,
          leadId: req.leadId,
          runId: req.runId ?? null,
          action: req.action,
        });

        currentStep = "completed";
        req.status = "completed";
        req.step = currentStep;
        req.completedAt = new Date().toISOString();
        req.error = null;
        req.updatedAt = new Date().toISOString();
        this.writeDeletionRequests(requests);
        return true;
      }

      return true;
    } catch (err) {
      req.status = "failed";
      req.step = currentStep;
      req.error = sanitizeErrorMessage(err);
      req.updatedAt = new Date().toISOString();
      this.writeDeletionRequests(requests);
      if (req.runId && (currentStep === "init" || currentStep === "ownership_verified")) {
        const projectStillExists = !!effectiveProjectStore.loadProject(req.clientId, req.runId);
        if (projectStillExists) {
          unmarkRunDeleted(req.runId);
        } else {
          markRunDeleted(req.runId);
        }
      }
      return false;
    } finally {
      releaseRun?.();
    }
  }

  deleteLead(clientId: string, id: string, options?: DeleteLeadOptions): boolean {
    const existing = this.getLead(clientId, id);
    if (!existing) return false;

    const shouldDeleteLinkedRun =
      options?.deleteLinkedRun ?? config.leadDeleteLinkedRuns;

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const requests = this.readDeletionRequests();
    requests.push({
      id: requestId,
      clientId,
      leadId: id,
      runId: existing.runId ?? null,
      deleteLinkedRun: shouldDeleteLinkedRun,
      status: "pending",
      step: "init",
      attempts: 0,
      error: null,
      action: "delete",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    this.writeDeletionRequests(requests);

    return this.executeDeletionRequest(requestId, options);
  }

  sweepExpiredLeads(retentionDays: number, options?: SweepLeadsOptions): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    if (!existsSync(config.leadDir)) return 0;

    let swept = 0;
    const shouldDeleteLinkedRuns =
      options?.deleteLinkedRuns ?? config.leadDeleteLinkedRuns;

    // R-002: Tenant-safe sweep: when options.clientId is provided, sweep only that tenant
    const clientDirs = options?.clientId
      ? [assertSafePathSegment(options.clientId, "clientId")]
      : readdirSync(config.leadDir);

    for (const clientDirName of clientDirs) {
      const clientPath = join(config.leadDir, clientDirName);
      try {
        const stat = statSync(clientPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      for (const file of readdirSync(clientPath)) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(clientPath, file);
        try {
          const lead = JSON.parse(readFileSync(filePath, "utf8")) as LeadRecord;
          if (lead && lead.createdAt && lead.createdAt < cutoff) {
            const requestId = randomUUID();
            const now = new Date().toISOString();
            const requests = this.readDeletionRequests();
            requests.push({
              id: requestId,
              clientId: lead.clientId,
              leadId: lead.id,
              runId: lead.runId ?? null,
              deleteLinkedRun: shouldDeleteLinkedRuns,
              status: "pending",
              step: "init",
              attempts: 0,
              error: null,
              action: "expire",
              createdAt: now,
              updatedAt: now,
              completedAt: null,
            });
            this.writeDeletionRequests(requests);

            const success = this.executeDeletionRequest(requestId, {
              projectStore: options?.projectStore,
              auditDir: options?.auditDir,
            });

            if (success) {
              swept++;
            }
          }
        } catch {
          throw new StageFailedClosedError("Lead retention sweep could not verify or persist a deletion.");
        }
      }
    }

    return swept;
  }

  processPendingDeletionRequests(options?: { projectStore?: ProjectStore; auditDir?: string }): {
    processed: number;
    succeeded: number;
    failed: number;
  } {
    const requests = this.readDeletionRequests();
    const pending = requests.filter((r) => r.status === "pending" || r.status === "processing");
    let succeeded = 0;
    let failed = 0;
    for (const req of pending) {
      const ok = this.executeDeletionRequest(req.id, {
        projectStore: options?.projectStore ?? this.projectStore,
        auditDir: options?.auditDir,
      });
      if (ok) succeeded++;
      else failed++;
    }
    return { processed: pending.length, succeeded, failed };
  }

  retryFailedDeletionRequests(options?: {
    projectStore?: ProjectStore;
    auditDir?: string;
    maxAttempts?: number;
    force?: boolean;
  }): {
    processed: number;
    succeeded: number;
    failed: number;
  } {
    const requests = this.readDeletionRequests();
    const maxAttempts = options?.maxAttempts ?? 5;
    const failedReqs = options?.force
      ? requests.filter((r) => r.status === "failed")
      : requests.filter((r) => r.status === "failed" && r.attempts < maxAttempts);
    let succeeded = 0;
    let failed = 0;
    for (const req of failedReqs) {
      const ok = this.executeDeletionRequest(req.id, {
        projectStore: options?.projectStore ?? this.projectStore,
        auditDir: options?.auditDir,
      });
      if (ok) succeeded++;
      else failed++;
    }
    return { processed: failedReqs.length, succeeded, failed };
  }

  cancelDeletionRequest(
    id: string,
    options?: { projectStore?: ProjectStore; auditDir?: string },
  ): boolean {
    const requests = this.readDeletionRequests();
    const req = requests.find((r) => r.id === id);
    if (!req) return false;
    if (req.status === "completed" || req.status === "cancelled") return false;
    if (
      req.step === "project_deleted" ||
      req.step === "jobs_deleted" ||
      req.step === "audit_deleted" ||
      req.step === "lead_deleted" ||
      req.step === "completed"
    ) {
      return false;
    }

    // Verify lead still exists before cancelling
    const lead = this.getLead(req.clientId, req.leadId);
    if (!lead) return false;

    // If linked run deletion was requested, verify the project and linked files still exist
    if (req.deleteLinkedRun && req.runId) {
      const effectiveProjectStore = options?.projectStore ?? this.projectStore ?? defaultStore;
      const intact = verifyProjectAndLinkedFilesExist(req.clientId, req.runId, {
        projectStore: effectiveProjectStore,
      });
      if (!intact) {
        markRunDeleted(req.runId);
        return false;
      }
    }

    req.status = "cancelled";
    req.updatedAt = new Date().toISOString();
    this.writeDeletionRequests(requests);
    if (req.runId) {
      unmarkRunDeleted(req.runId);
    }
    return true;
  }

  retryDeletionRequest(
    id: string,
    options?: { projectStore?: ProjectStore; auditDir?: string; force?: boolean },
  ): boolean {
    const requests = this.readDeletionRequests();
    const req = requests.find((r) => r.id === id);
    if (!req) return false;
    if (req.status === "completed") return true;
    if (options?.force || req.attempts >= 5) {
      req.status = "pending";
      req.attempts = 0;
      req.error = null;
      req.updatedAt = new Date().toISOString();
      this.writeDeletionRequests(requests);
    }
    return this.executeDeletionRequest(id, {
      projectStore: options?.projectStore ?? this.projectStore,
      auditDir: options?.auditDir,
    });
  }

  listLeads(clientId: string): LeadRecord[] {
    const dir = clientLeadDir(clientId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listLeadsByUser(clientId: string, userSub: string): LeadRecord[] {
    const dir = clientLeadDir(clientId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadRecord)
      .filter((lead) => lead.userSub === userSub)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const defaultLeadStore: LeadStore = new JsonLeadStore();

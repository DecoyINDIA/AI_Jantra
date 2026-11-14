import {
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
import type Database from "better-sqlite3";
import { config } from "../../config.js";
import { assertSafePathSegment, defaultStore, type ProjectStore } from "../../pipeline/store.js";
import { AuditLogger } from "../../audit.js";

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

export interface DeleteLeadOptions {
  deleteLinkedRun?: boolean;
  projectStore?: ProjectStore;
  auditDir?: string;
}

export interface SweepLeadsOptions {
  deleteLinkedRuns?: boolean;
  projectStore?: ProjectStore;
  auditDir?: string;
}

export function deleteLinkedRunData(
  clientId: string,
  runId: string,
  options?: { projectStore?: ProjectStore; auditDir?: string; db?: Database.Database },
): boolean {
  assertSafePathSegment(clientId, "clientId");
  assertSafePathSegment(runId, "runId");

  const projectStore = options?.projectStore ?? defaultStore;
  const auditDir = options?.auditDir ?? config.auditDir;

  // 1. If db is available, check if the run belongs to another client
  if (options?.db) {
    try {
      const row = options.db
        .prepare("select client_id from projects where project_id = ?")
        .get(runId) as { client_id: string } | undefined;
      if (row && row.client_id !== clientId) {
        return false;
      }
    } catch {}
  }

  // 2. Check projectStore
  const existingProject = projectStore.loadProject(clientId, runId);
  if (existingProject && existingProject.clientId !== clientId) {
    return false;
  }

  // 3. Inspect audit file if it exists: ensure it doesn't belong to another client
  const auditFile = join(auditDir, `${runId}.jsonl`);
  if (existsSync(auditFile)) {
    try {
      const firstLine = readFileSync(auditFile, "utf8").split("\n")[0];
      if (firstLine) {
        const parsed = JSON.parse(firstLine) as { clientId?: string };
        if (parsed.clientId && parsed.clientId !== clientId) {
          return false;
        }
      }
    } catch {}
  }

  // Idempotently delete project in projectStore
  if (typeof projectStore.deleteProject === "function") {
    projectStore.deleteProject(clientId, runId);
  }

  // Idempotently delete audit file for runId
  if (existsSync(auditFile)) {
    try {
      rmSync(auditFile, { force: true });
    } catch {
      // Ignore if already deleted
    }
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

export class SqliteLeadStore implements LeadStore {
  constructor(private readonly db: Database.Database) {}

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

  deleteLead(clientId: string, id: string, options?: DeleteLeadOptions): boolean {
    const existing = this.getLead(clientId, id);
    if (!existing) return false;

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "update leads set deleted_at = ? where client_id = ? and id = ? and deleted_at is null",
      )
      .run(now, clientId, id);
    if (result.changes === 0) return false;

    const shouldDeleteLinkedRun =
      options?.deleteLinkedRun ?? config.leadDeleteLinkedRuns;

    if (shouldDeleteLinkedRun && existing.runId) {
      const allowed = deleteLinkedRunData(clientId, existing.runId, {
        projectStore: options?.projectStore,
        auditDir: options?.auditDir,
        db: this.db,
      });
      if (allowed) {
        this.db
          .prepare("delete from projects where client_id = ? and project_id = ?")
          .run(clientId, existing.runId);
        this.db
          .prepare("delete from jobs where client_id = ? and run_id = ?")
          .run(clientId, existing.runId);
      }
    }

    const auditDir = options?.auditDir ?? config.auditDir;
    const audit = new AuditLogger("system", auditDir);
    audit.record("lead_deleted", {
      clientId,
      leadId: id,
      runId: existing.runId ?? null,
      action: "delete",
    });

    return true;
  }

  sweepExpiredLeads(retentionDays: number, options?: SweepLeadsOptions): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const expiredRows = this.db
      .prepare(
        "select id, client_id, run_id from leads where created_at < ? and deleted_at is null",
      )
      .all(cutoff) as Array<{ id: string; client_id: string; run_id: string | null }>;

    if (expiredRows.length === 0) return 0;

    this.db
      .prepare(
        "update leads set deleted_at = ? where created_at < ? and deleted_at is null",
      )
      .run(now, cutoff);

    const shouldDeleteLinkedRuns =
      options?.deleteLinkedRuns ?? config.leadDeleteLinkedRuns;
    const auditDir = options?.auditDir ?? config.auditDir;

    for (const row of expiredRows) {
      if (shouldDeleteLinkedRuns && row.run_id) {
        const allowed = deleteLinkedRunData(row.client_id, row.run_id, {
          projectStore: options?.projectStore,
          auditDir,
          db: this.db,
        });
        if (allowed) {
          this.db
            .prepare("delete from projects where client_id = ? and project_id = ?")
            .run(row.client_id, row.run_id);
          this.db
            .prepare("delete from jobs where client_id = ? and run_id = ?")
            .run(row.client_id, row.run_id);
        }
      }

      const audit = new AuditLogger("system", auditDir);
      audit.record("lead_deleted", {
        clientId: row.client_id,
        leadId: row.id,
        runId: row.run_id ?? null,
        action: "expire",
      });
    }

    return expiredRows.length;
  }
}

export class JsonLeadStore implements LeadStore {
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

  deleteLead(clientId: string, id: string, options?: DeleteLeadOptions): boolean {
    const existing = this.getLead(clientId, id);
    if (!existing) return false;

    const file = leadFile(clientId, id);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });

    const shouldDeleteLinkedRun =
      options?.deleteLinkedRun ?? config.leadDeleteLinkedRuns;

    if (shouldDeleteLinkedRun && existing.runId) {
      deleteLinkedRunData(clientId, existing.runId, {
        projectStore: options?.projectStore,
        auditDir: options?.auditDir,
      });
    }

    const auditDir = options?.auditDir ?? config.auditDir;
    const audit = new AuditLogger("system", auditDir);
    audit.record("lead_deleted", {
      clientId,
      leadId: id,
      runId: existing.runId ?? null,
      action: "delete",
    });

    return true;
  }

  sweepExpiredLeads(retentionDays: number, options?: SweepLeadsOptions): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    if (!existsSync(config.leadDir)) return 0;

    let swept = 0;
    const shouldDeleteLinkedRuns =
      options?.deleteLinkedRuns ?? config.leadDeleteLinkedRuns;
    const auditDir = options?.auditDir ?? config.auditDir;

    for (const clientDirName of readdirSync(config.leadDir)) {
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
            rmSync(filePath, { force: true });
            swept++;

            if (shouldDeleteLinkedRuns && lead.runId) {
              deleteLinkedRunData(lead.clientId, lead.runId, {
                projectStore: options?.projectStore,
                auditDir,
              });
            }

            const audit = new AuditLogger("system", auditDir);
            audit.record("lead_deleted", {
              clientId: lead.clientId,
              leadId: lead.id,
              runId: lead.runId ?? null,
              action: "expire",
            });
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    return swept;
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

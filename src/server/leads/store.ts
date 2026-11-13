import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { config } from "../../config.js";
import { assertSafePathSegment } from "../../pipeline/store.js";

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

export interface LeadStore {
  createLead(record: LeadRecord): LeadRecord;
  listLeads(clientId: string): LeadRecord[];
  listLeadsByUser(clientId: string, userSub: string): LeadRecord[];
  deleteLead?(clientId: string, id: string): boolean;
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

  deleteLead(clientId: string, id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "update leads set deleted_at = ? where client_id = ? and id = ? and deleted_at is null",
      )
      .run(now, clientId, id);
    return result.changes > 0;
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

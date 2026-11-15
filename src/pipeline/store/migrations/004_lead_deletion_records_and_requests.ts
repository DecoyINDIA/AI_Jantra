import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export function up(db: Database.Database): void {
  // 1. Lead deletions table: minimal non-personal deletion audit records
  // outside the leads table and outside erased run audit logs (R-001)
  db.exec(`
    create table if not exists lead_deletions (
      id text primary key,
      client_id text not null,
      lead_id text not null,
      run_id text,
      deleted_at text not null,
      action text not null
    );

    create index if not exists idx_lead_deletions_client
      on lead_deletions (client_id, deleted_at desc);
  `);

  // 2. Lead deletion requests table: durable queue for tracking recoverable
  // deletion operations and their execution lifecycle (R-003)
  db.exec(`
    create table if not exists lead_deletion_requests (
      id text primary key,
      client_id text not null,
      lead_id text not null,
      run_id text,
      delete_linked_run integer not null default 0,
      status text not null default 'pending',
      step text not null default 'init',
      attempts integer not null default 0,
      error text,
      action text not null default 'delete',
      created_at text not null,
      updated_at text not null,
      completed_at text
    );

    create index if not exists idx_lead_deletion_requests_status
      on lead_deletion_requests (status, updated_at);
    create index if not exists idx_lead_deletion_requests_client
      on lead_deletion_requests (client_id, lead_id);
  `);

  const reqCols = db.prepare("pragma table_info(lead_deletion_requests)").all() as Array<{ name: string }>;
  if (!reqCols.some((col) => col.name.toLowerCase() === "step")) {
    db.exec("alter table lead_deletion_requests add column step text not null default 'init'");
  }

  // 3. Remediate pre-existing soft-deleted rows in leads table:
  // Transfer to lead_deletions and permanently purge from leads table (R-001).
  // Surface failures immediately rather than swallowing errors (Finding 5).
  const tableInfo = db.prepare("pragma table_info(leads)").all() as Array<{ name: string }>;
  const hasDeletedAt = tableInfo.some((col) => col.name.toLowerCase() === "deleted_at");
  if (hasDeletedAt) {
    const softDeleted = db
      .prepare("select id, client_id, run_id, deleted_at from leads where deleted_at is not null")
      .all() as Array<{ id: string; client_id: string; run_id: string | null; deleted_at: string }>;

    if (softDeleted.length > 0) {
      const insertRecord = db.prepare(
        "insert or ignore into lead_deletions (id, client_id, lead_id, run_id, deleted_at, action) values (?, ?, ?, ?, ?, ?)",
      );
      const purgeLead = db.prepare("delete from leads where id = ?");

      for (const row of softDeleted) {
        insertRecord.run(
          randomUUID(),
          row.client_id,
          row.id,
          row.run_id,
          row.deleted_at || new Date().toISOString(),
          "remediated_soft_delete",
        );
        purgeLead.run(row.id);
      }
    }

    const remaining = db
      .prepare("select count(*) as count from leads where deleted_at is not null")
      .get() as { count: number };
    if (remaining.count > 0) {
      throw new Error(
        `Migration 004 remediation failed: ${remaining.count} soft-deleted leads still contain personal data.`,
      );
    }
  }
}

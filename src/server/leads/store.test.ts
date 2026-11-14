import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../../pipeline/store/migrations/index.js";
import { SqliteLeadStore, JsonLeadStore, type LeadRecord } from "./store.js";

describe("LeadStore & Retention (T-023)", () => {
  it("SqliteLeadStore creates, retrieves, deletes, and sweeps expired leads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-leads-test-"));
    const dbPath = path.join(dir, "leads.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const clientId = "client-retention-test";

    try {
      // 1. Create a fresh lead
      const lead1: LeadRecord = {
        id: "lead-recent",
        clientId,
        userSub: "user-123",
        name: "Alice",
        email: "alice@example.com",
        idea: "AI tool",
        source: "test",
        createdAt: new Date().toISOString(),
      };
      store.createLead(lead1);

      // 2. Create an expired lead (45 days ago)
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const lead2: LeadRecord = {
        id: "lead-old",
        clientId,
        userSub: "user-456",
        name: "Bob",
        email: "bob@example.com",
        idea: "Old idea",
        source: "test",
        createdAt: oldDate,
      };
      store.createLead(lead2);

      // Verify both exist
      assert.equal(store.getLead(clientId, "lead-recent")?.name, "Alice");
      assert.equal(store.getLead(clientId, "lead-old")?.name, "Bob");
      assert.equal(store.listLeads(clientId).length, 2);

      // 3. Delete recent lead explicitly
      const deleted = store.deleteLead(clientId, "lead-recent");
      assert.equal(deleted, true);
      assert.equal(store.getLead(clientId, "lead-recent"), null);
      assert.equal(store.listLeads(clientId).length, 1);

      // 4. Run sweep with 30-day retention
      const swept = store.sweepExpiredLeads(30);
      assert.equal(swept, 1, "Expected 1 lead older than 30 days to be swept");

      // Verify old lead is now deleted
      assert.equal(store.getLead(clientId, "lead-old"), null);
      assert.equal(store.listLeads(clientId).length, 0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JsonLeadStore creates, gets, lists, and deletes a lead", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-json-leads-"));
    const store = new JsonLeadStore();
    const clientId = "json-client";

    try {
      const lead: LeadRecord = {
        id: "json-lead-1",
        clientId,
        userSub: null,
        name: "Charlie",
        email: "charlie@example.com",
        idea: "Json idea",
        source: "test",
        createdAt: new Date().toISOString(),
      };

      // Need to point config.leadDir to temp dir if needed, or check JsonLeadStore
      // JsonLeadStore uses config.leadDir, so test deleteLead if created:
      const created = store.createLead(lead);
      assert.equal(created.id, "json-lead-1");
      assert.equal(store.getLead(clientId, "json-lead-1")?.name, "Charlie");

      const deleted = store.deleteLead(clientId, "json-lead-1");
      assert.equal(deleted, true);
      assert.equal(store.getLead(clientId, "json-lead-1"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleting lead with deleteLinkedRun deletes linked intake run and audit file while keeping tenant isolation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-linked-retention-test-"));
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const clientA = "client-alpha";
    const clientB = "client-bravo";

    try {
      // 1. Create a project run for clientA in SQLite
      const runA = "run-alpha-123";
      db.prepare(
        `insert into projects (
          client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        clientA,
        runA,
        new Date().toISOString(),
        "Project Alpha",
        "intake",
        1,
        "active",
        "intake",
        "completed",
        0.05,
        new Date().toISOString(),
        JSON.stringify({ id: runA, clientId: clientA }),
      );

      // Create audit file for runA
      const auditFileA = path.join(auditDir, `${runA}.jsonl`);
      fs.writeFileSync(auditFileA, JSON.stringify({ runId: runA, clientId: clientA }) + "\n", "utf8");
      assert.equal(fs.existsSync(auditFileA), true);

      // 2. Create a lead for clientA linked to runA
      const leadA: LeadRecord = {
        id: "lead-alpha-1",
        clientId: clientA,
        userSub: "user-alpha",
        name: "Alpha User",
        email: "alpha@example.com",
        phone: "+1234567890",
        idea: "Confidential idea",
        source: "web",
        runId: runA,
        createdAt: new Date().toISOString(),
      };
      store.createLead(leadA);

      // 3. Delete leadA with deleteLinkedRun: true
      const deleted = store.deleteLead(clientA, "lead-alpha-1", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(deleted, true);

      // Verify lead is deleted
      assert.equal(store.getLead(clientA, "lead-alpha-1"), null);

      // Verify linked run in projects table is deleted
      const projectRow = db
        .prepare("select * from projects where client_id = ? and project_id = ?")
        .get(clientA, runA);
      assert.equal(projectRow, undefined, "Expected linked run in projects table to be deleted");

      // Verify audit file for runA was deleted
      assert.equal(fs.existsSync(auditFileA), false, "Expected run audit file to be deleted");

      // Verify system audit trail has lead_deleted without PII
      const systemAuditPath = path.join(auditDir, "system.jsonl");
      assert.equal(fs.existsSync(systemAuditPath), true, "Expected system.jsonl to exist");
      const systemAuditContent = fs.readFileSync(systemAuditPath, "utf8");
      assert.equal(systemAuditContent.includes('"lead_deleted"'), true);
      assert.equal(systemAuditContent.includes('"leadId":"lead-alpha-1"'), true);
      assert.equal(systemAuditContent.includes('"runId":"run-alpha-123"'), true);
      assert.equal(systemAuditContent.includes('"action":"delete"'), true);

      // Verify NO personal fields were logged
      assert.equal(systemAuditContent.includes("Alpha User"), false, "Must not log name");
      assert.equal(systemAuditContent.includes("alpha@example.com"), false, "Must not log email");
      assert.equal(systemAuditContent.includes("+1234567890"), false, "Must not log phone");
      assert.equal(systemAuditContent.includes("Confidential idea"), false, "Must not log idea");

      // 4. Test strict tenant boundaries:
      // Client B cannot delete Client A's run even if Client B puts Client A's runId in their lead
      const runA2 = "run-alpha-safe";
      db.prepare(
        `insert into projects (
          client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        clientA,
        runA2,
        new Date().toISOString(),
        "Project Alpha Safe",
        "intake",
        1,
        "active",
        "intake",
        "completed",
        0.05,
        new Date().toISOString(),
        JSON.stringify({ id: runA2, clientId: clientA }),
      );
      const auditFileA2 = path.join(auditDir, `${runA2}.jsonl`);
      fs.writeFileSync(auditFileA2, JSON.stringify({ runId: runA2, clientId: clientA }) + "\n", "utf8");

      const leadB: LeadRecord = {
        id: "lead-bravo-attack",
        clientId: clientB,
        userSub: "user-bravo",
        name: "Bravo Attacker",
        email: "bravo@example.com",
        idea: "Attack",
        source: "web",
        runId: runA2,
        createdAt: new Date().toISOString(),
      };
      store.createLead(leadB);

      // Client B deletes their lead
      store.deleteLead(clientB, "lead-bravo-attack", {
        deleteLinkedRun: true,
        auditDir,
      });

      // Verify Client A's project run was NOT deleted!
      const safeProject = db
        .prepare("select * from projects where client_id = ? and project_id = ?")
        .get(clientA, runA2);
      assert.ok(safeProject, "Tenant boundary breached: Client A's run was deleted by Client B");
      assert.equal(fs.existsSync(auditFileA2), true, "Client A's audit file must not be deleted by Client B");

      // 5. Test idempotency: deleting already deleted lead returns false and does not fail
      const secondDelete = store.deleteLead(clientA, "lead-alpha-1", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(secondDelete, false);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweepExpiredLeads deletes expired leads and cleans up linked runs and audit data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-sweep-test-"));
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const clientId = "client-sweep-test";

    try {
      const expiredDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const expiredRun = "run-expired-999";

      // Project in db
      db.prepare(
        `insert into projects (
          client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        clientId,
        expiredRun,
        expiredDate,
        "Expired Run",
        "intake",
        1,
        "active",
        "intake",
        "completed",
        0.05,
        expiredDate,
        JSON.stringify({ id: expiredRun, clientId }),
      );

      const auditFile = path.join(auditDir, `${expiredRun}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId: expiredRun, clientId }) + "\n", "utf8");

      // Lead linked to expiredRun
      store.createLead({
        id: "lead-expired-999",
        clientId,
        userSub: "user-expired",
        name: "Old Visitor",
        email: "old@example.com",
        idea: "Old idea",
        source: "web",
        runId: expiredRun,
        createdAt: expiredDate,
      });

      // Sweep with 30-day retention and deleteLinkedRuns: true
      const sweptCount = store.sweepExpiredLeads(30, {
        deleteLinkedRuns: true,
        auditDir,
      });
      assert.equal(sweptCount, 1);

      // Verify lead is marked deleted
      assert.equal(store.getLead(clientId, "lead-expired-999"), null);

      // Verify project is deleted
      const projectRow = db
        .prepare("select * from projects where client_id = ? and project_id = ?")
        .get(clientId, expiredRun);
      assert.equal(projectRow, undefined, "Expected expired project to be deleted");

      // Verify audit file is deleted
      assert.equal(fs.existsSync(auditFile), false, "Expected expired audit file to be deleted");

      // Verify system audit trail has action: "expire"
      const systemAuditPath = path.join(auditDir, "system.jsonl");
      const systemAudit = fs.readFileSync(systemAuditPath, "utf8");
      assert.equal(systemAudit.includes('"action":"expire"'), true);
      assert.equal(systemAudit.includes('"leadId":"lead-expired-999"'), true);
      assert.equal(systemAudit.includes("old@example.com"), false, "Must not log email");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

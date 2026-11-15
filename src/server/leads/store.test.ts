import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../../pipeline/store/migrations/index.js";
import { SqliteLeadStore, JsonLeadStore, sanitizeErrorMessage, type LeadRecord } from "./store.js";
import { SqliteProjectStore } from "../../pipeline/store/sqlite.js";
import { JsonProjectStore, type ProjectStore } from "../../pipeline/store.js";
import { config } from "../../config.js";
import {
  coordinateRunDeletion,
  createProject,
  isRunDeleted,
  isRunLocked,
  resetRunLocksForTesting,
  tryAcquireRunLock,
  unmarkRunDeleted,
  withRunLock,
} from "../../pipeline/orchestrator.js";

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

  it("R-001: Direct SQL inspection verifies all personal data purged on deletion/expiry, minimal non-personal record recorded, and pre-existing soft-deleted rows remediated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-r001-test-"));
    const dbPath = path.join(dir, "r001.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const clientId = "tenant-r001";

    try {
      // 1. Create a lead with all personal data fields populated
      const leadId = "r001-lead-active";
      const personalLead: LeadRecord = {
        id: leadId,
        clientId,
        userSub: "sub-r001-secret",
        name: "Confidential Founder",
        email: "founder@secret-domain.test",
        phone: "+1-555-0199",
        idea: "Proprietary patent-pending stealth engine",
        source: "eval",
        createdAt: new Date().toISOString(),
      };
      store.createLead(personalLead);

      // Verify row exists and personal fields are readable via direct SQL before deletion
      const preRow = db.prepare("select * from leads where id = ?").get(leadId) as any;
      assert.ok(preRow, "Lead must exist in raw table before deletion");
      assert.equal(preRow.name, "Confidential Founder");
      assert.equal(preRow.email, "founder@secret-domain.test");
      assert.equal(preRow.phone, "+1-555-0199");
      assert.equal(preRow.idea, "Proprietary patent-pending stealth engine");
      assert.equal(preRow.user_sub, "sub-r001-secret");

      // 2. Perform manual deletion
      const deleted = store.deleteLead(clientId, leadId);
      assert.equal(deleted, true);

      // Verify direct SQL inspection: row is completely purged from leads table
      const postRow = db.prepare("select * from leads where id = ?").get(leadId);
      assert.equal(postRow, undefined, "Lead row must be completely removed from leads table");

      // Verify direct SQL cannot find personal data anywhere in leads table
      const personalMatch = db.prepare(`
        select count(*) as count from leads
        where name = ? or email = ? or phone = ? or idea = ? or user_sub = ?
      `).get(
        "Confidential Founder",
        "founder@secret-domain.test",
        "+1-555-0199",
        "Proprietary patent-pending stealth engine",
        "sub-r001-secret",
      ) as { count: number };
      assert.equal(personalMatch.count, 0, "No personal data fields should be retrievable from leads table");

      // Verify minimal non-personal deletion audit record in lead_deletions table
      const deletionRecord = db.prepare("select * from lead_deletions where lead_id = ?").get(leadId) as any;
      assert.ok(deletionRecord, "Minimal non-personal deletion record must exist in lead_deletions");
      assert.equal(deletionRecord.client_id, clientId);
      assert.equal(deletionRecord.lead_id, leadId);
      assert.equal(deletionRecord.action, "delete");
      assert.ok(deletionRecord.deleted_at);
      // Ensure lead_deletions has no PII columns
      const tableCols = (db.prepare("pragma table_info(lead_deletions)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(tableCols.sort(), ["action", "client_id", "deleted_at", "id", "lead_id", "run_id"].sort());

      // 3. Expiry test with direct SQL inspection
      const expiredLeadId = "r001-expired-lead";
      const expiredDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      store.createLead({
        id: expiredLeadId,
        clientId,
        userSub: "sub-expired-user",
        name: "Expired Founder",
        email: "expired@stealth.test",
        phone: "+1-555-0299",
        idea: "Expired proprietary patent idea",
        source: "eval",
        createdAt: expiredDate,
      });

      const swept = store.sweepExpiredLeads(30);
      assert.equal(swept, 1);

      // Direct SQL check on expired lead
      const expiredRow = db.prepare("select * from leads where id = ?").get(expiredLeadId);
      assert.equal(expiredRow, undefined, "Expired lead must be purged from leads table");
      const expiredMatch = db.prepare(`
        select count(*) as count from leads where name = 'Expired Founder' or email = 'expired@stealth.test'
      `).get() as { count: number };
      assert.equal(expiredMatch.count, 0, "Expired personal data must not be retrievable via SQL");

      const expiredRecord = db.prepare("select * from lead_deletions where lead_id = ?").get(expiredLeadId) as any;
      assert.ok(expiredRecord);
      assert.equal(expiredRecord.action, "expire");

      // 4. Remediation of pre-existing soft-deleted rows
      const legacyId = "r001-legacy-soft-deleted";
      db.prepare(`
        insert into leads (id, client_id, user_sub, name, email, phone, idea, source, run_id, created_at, deleted_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        legacyId,
        clientId,
        "sub-legacy-unpurged",
        "Legacy Unpurged User",
        "legacy@unpurged.test",
        "+1-555-0999",
        "Legacy unpurged idea in soft-deleted row",
        "legacy",
        "run-legacy-99",
        new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      );

      // Verify the legacy row exists before remediation
      const legacyPre = db.prepare("select * from leads where id = ?").get(legacyId) as any;
      assert.ok(legacyPre, "Pre-remediation legacy row must exist");
      assert.equal(legacyPre.email, "legacy@unpurged.test");

      // Run remediation
      const remediatedCount = store.remediateSoftDeletedLeads();
      assert.ok(remediatedCount >= 1, "Expected at least 1 legacy soft-deleted lead to be remediated");

      // Verify direct SQL inspection: legacy row completely purged from leads table
      const legacyPost = db.prepare("select * from leads where id = ?").get(legacyId);
      assert.equal(legacyPost, undefined, "Remediated legacy row must be purged from leads table");

      const legacyPIIMatch = db.prepare(`
        select count(*) as count from leads where email = 'legacy@unpurged.test' or name = 'Legacy Unpurged User'
      `).get() as { count: number };
      assert.equal(legacyPIIMatch.count, 0, "Remediated PII must not be in leads table");

      // Verify non-personal record exists in lead_deletions
      const remediatedRecord = db.prepare("select * from lead_deletions where lead_id = ?").get(legacyId) as any;
      assert.ok(remediatedRecord, "Remediated record must be recorded in lead_deletions");
      assert.equal(remediatedRecord.action, "remediated_soft_delete");
      assert.equal(remediatedRecord.client_id, clientId);
      assert.equal(remediatedRecord.run_id, "run-legacy-99");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R-002: Multi-tenant sweeps in SQLite and JSON stores strictly isolate tenant data and leave other tenants untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-r002-test-"));
    const dbPath = path.join(dir, "r002.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const tenantA = "tenant-alpha";
    const tenantB = "tenant-bravo";

    try {
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

      // 1. Setup Tenant A expired lead and run
      const runA = "run-a-sweep";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tenantA, runA, oldDate, "Run Alpha", "intake", 1, "active", "intake", "completed", 0.05, oldDate, JSON.stringify({ id: runA, clientId: tenantA }));
      const auditFileA = path.join(auditDir, `${runA}.jsonl`);
      fs.writeFileSync(auditFileA, JSON.stringify({ runId: runA, clientId: tenantA }) + "\n", "utf8");

      store.createLead({
        id: "lead-a-exp",
        clientId: tenantA,
        userSub: "user-a",
        name: "Alpha Lead",
        email: "alpha@tenant-a.test",
        idea: "Tenant A Idea",
        source: "eval",
        runId: runA,
        createdAt: oldDate,
      });

      // 2. Setup Tenant B expired lead and run
      const runB = "run-b-sweep";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tenantB, runB, oldDate, "Run Bravo", "intake", 1, "active", "intake", "completed", 0.05, oldDate, JSON.stringify({ id: runB, clientId: tenantB }));
      const auditFileB = path.join(auditDir, `${runB}.jsonl`);
      fs.writeFileSync(auditFileB, JSON.stringify({ runId: runB, clientId: tenantB }) + "\n", "utf8");

      store.createLead({
        id: "lead-b-exp",
        clientId: tenantB,
        userSub: "user-b",
        name: "Bravo Lead",
        email: "bravo@tenant-b.test",
        idea: "Tenant B Idea",
        source: "eval",
        runId: runB,
        createdAt: oldDate,
      });

      // Verify both exist initially
      assert.ok(store.getLead(tenantA, "lead-a-exp"));
      assert.ok(store.getLead(tenantB, "lead-b-exp"));

      // 3. Tenant A executes a manual tenant-scoped sweep
      const sweptCount = store.sweepExpiredLeads(30, {
        clientId: tenantA,
        deleteLinkedRuns: true,
        auditDir,
      });
      assert.equal(sweptCount, 1, "Tenant A sweep should sweep exactly 1 lead");

      // Verify Tenant A data was purged
      assert.equal(store.getLead(tenantA, "lead-a-exp"), null, "Tenant A lead must be purged");
      const projectA = db.prepare("select * from projects where client_id = ? and project_id = ?").get(tenantA, runA);
      assert.equal(projectA, undefined, "Tenant A project must be deleted");
      assert.equal(fs.existsSync(auditFileA), false, "Tenant A audit file must be deleted");

      // CRITICAL R-002: Verify Tenant B data remains completely intact!
      const leadB = store.getLead(tenantB, "lead-b-exp");
      assert.ok(leadB, "Tenant B lead must remain untouched by Tenant A sweep");
      assert.equal(leadB.email, "bravo@tenant-b.test");

      const projectB = db.prepare("select * from projects where client_id = ? and project_id = ?").get(tenantB, runB);
      assert.ok(projectB, "Tenant B project must remain completely intact in database");

      assert.equal(fs.existsSync(auditFileB), true, "Tenant B audit file must remain completely intact");

      // 4. Test Multi-tenant sweep in JsonLeadStore
      const prevLeadDir = config.leadDir;
      const jsonLeadsDir = path.join(dir, "json-leads");
      (config as { leadDir: string }).leadDir = jsonLeadsDir;

      try {
        const jsonStore = new JsonLeadStore();

        jsonStore.createLead({
          id: "json-lead-a",
          clientId: tenantA,
          userSub: null,
          name: "JSON A",
          email: "a@json.test",
          idea: "Idea A",
          source: "eval",
          createdAt: oldDate,
        });

        jsonStore.createLead({
          id: "json-lead-b",
          clientId: tenantB,
          userSub: null,
          name: "JSON B",
          email: "b@json.test",
          idea: "Idea B",
          source: "eval",
          createdAt: oldDate,
        });

        // Tenant A sweeps JSON store with clientId: tenantA
        const jsonSwept = jsonStore.sweepExpiredLeads(30, { clientId: tenantA });
        assert.equal(jsonSwept, 1, "JSON sweep for Tenant A must sweep only Tenant A");

        assert.equal(jsonStore.getLead(tenantA, "json-lead-a"), null, "Tenant A JSON lead must be removed");
        assert.ok(jsonStore.getLead(tenantB, "json-lead-b"), "Tenant B JSON lead must be completely untouched");

        // Global sweep with no clientId sweeps remaining tenants
        const globalSwept = jsonStore.sweepExpiredLeads(30);
        assert.equal(globalSwept, 1, "Global JSON sweep must sweep Tenant B");
        assert.equal(jsonStore.getLead(tenantB, "json-lead-b"), null);
      } finally {
        (config as { leadDir: string }).leadDir = prevLeadDir;
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R-003: Injected failures, ownership verification, locks, shared runs, running jobs, and recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-r003-test-"));
    const dbPath = path.join(dir, "r003.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const db = new Database(dbPath);
    runMigrations(db);

    const store = new SqliteLeadStore(db);
    const clientId = "tenant-r003";

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    try {
      // 1. Malformed / unreadable audit ownership evidence fails closed
      const runBadAudit = "run-bad-audit";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runBadAudit, new Date().toISOString(), "Bad Audit Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runBadAudit, clientId }));

      const badAuditFile = path.join(auditDir, `${runBadAudit}.jsonl`);
      fs.writeFileSync(badAuditFile, "NOT_JSON_{invalid}\n", "utf8");

      store.createLead({
        id: "lead-bad-audit",
        clientId,
        userSub: null,
        name: "Bad Audit User",
        email: "bad-audit@example.com",
        idea: "Idea with corrupt audit",
        source: "eval",
        runId: runBadAudit,
        createdAt: new Date().toISOString(),
      });

      // Deletion must fail closed
      const delBadAuditRes = store.deleteLead(clientId, "lead-bad-audit", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delBadAuditRes, false, "Must fail closed on malformed audit ownership evidence");

      // Verify run and audit file were NOT deleted
      assert.ok(db.prepare("select * from projects where project_id = ?").get(runBadAudit), "Project must not be deleted");
      assert.equal(fs.existsSync(badAuditFile), true, "Audit file must not be deleted");

      // Verify deletion request exists with status 'failed'
      const failedReqs = store.listDeletionRequests(clientId, "failed");
      const badAuditReq = failedReqs.find((r) => r.leadId === "lead-bad-audit");
      assert.ok(badAuditReq, "Failed deletion request must be recorded");
      assert.equal(badAuditReq.error, "Lead deletion failed closed. Retry after operator review.");

      // Fix the audit file and test retry
      fs.writeFileSync(badAuditFile, JSON.stringify({ runId: runBadAudit, clientId }) + "\n", "utf8");
      const retryResult = store.retryFailedDeletionRequests({ auditDir });
      assert.equal(retryResult.succeeded, 1, "Retry should succeed after fixing audit file");
      assert.equal(db.prepare("select * from projects where project_id = ?").get(runBadAudit), undefined, "Project should be deleted after retry");
      assert.equal(fs.existsSync(badAuditFile), false, "Audit file should be deleted after retry");

      // 2. Audit file belonging to another client fails closed
      const runAuditMismatch = "run-audit-mismatch";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runAuditMismatch, new Date().toISOString(), "Mismatch Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runAuditMismatch, clientId }));

      const mismatchAuditFile = path.join(auditDir, `${runAuditMismatch}.jsonl`);
      fs.writeFileSync(mismatchAuditFile, JSON.stringify({ runId: runAuditMismatch, clientId: "attacker-client" }) + "\n", "utf8");

      store.createLead({
        id: "lead-audit-mismatch",
        clientId,
        userSub: null,
        name: "Mismatch User",
        email: "mismatch@example.com",
        idea: "Idea with mismatched audit client",
        source: "eval",
        runId: runAuditMismatch,
        createdAt: new Date().toISOString(),
      });

      const delMismatchRes = store.deleteLead(clientId, "lead-audit-mismatch", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delMismatchRes, false, "Must fail closed on audit client mismatch");
      assert.ok(db.prepare("select * from projects where project_id = ?").get(runAuditMismatch), "Project must remain intact");
      assert.equal(fs.existsSync(mismatchAuditFile), true, "Audit file must remain intact");

      // 3. Shared run links between multiple active leads
      const runShared = "run-shared-between-leads";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runShared, new Date().toISOString(), "Shared Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runShared, clientId }));

      const sharedAuditFile = path.join(auditDir, `${runShared}.jsonl`);
      fs.writeFileSync(sharedAuditFile, JSON.stringify({ runId: runShared, clientId }) + "\n", "utf8");

      store.createLead({
        id: "lead-shared-1",
        clientId,
        userSub: null,
        name: "Shared User 1",
        email: "shared1@example.com",
        idea: "Shared Idea",
        source: "eval",
        runId: runShared,
        createdAt: new Date().toISOString(),
      });

      store.createLead({
        id: "lead-shared-2",
        clientId,
        userSub: null,
        name: "Shared User 2",
        email: "shared2@example.com",
        idea: "Shared Idea",
        source: "eval",
        runId: runShared,
        createdAt: new Date().toISOString(),
      });

      // Delete Lead 1 with deleteLinkedRun: true
      const delLead1Res = store.deleteLead(clientId, "lead-shared-1", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delLead1Res, true, "Lead 1 deletion should succeed");
      assert.equal(store.getLead(clientId, "lead-shared-1"), null, "Lead 1 must be deleted");

      // Run and audit file MUST NOT be deleted because Lead 2 is still active and references runShared!
      assert.ok(db.prepare("select * from projects where project_id = ?").get(runShared), "Shared run must NOT be deleted while Lead 2 is still active");
      assert.equal(fs.existsSync(sharedAuditFile), true, "Shared audit file must NOT be deleted while Lead 2 is still active");

      // Now delete Lead 2 with deleteLinkedRun: true
      const delLead2Res = store.deleteLead(clientId, "lead-shared-2", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delLead2Res, true, "Lead 2 deletion should succeed");
      assert.equal(store.getLead(clientId, "lead-shared-2"), null, "Lead 2 must be deleted");

      // NOW the run and audit file SHOULD be deleted!
      assert.equal(db.prepare("select * from projects where project_id = ?").get(runShared), undefined, "Shared run must be deleted once no active leads reference it");
      assert.equal(fs.existsSync(sharedAuditFile), false, "Shared audit file must be deleted once no active leads reference it");

      // 4. Running / Queued job coordination: cannot delete while job is running
      const runWithJob = "run-with-active-job";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runWithJob, new Date().toISOString(), "Job Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runWithJob, clientId }));

      const jobAuditFile = path.join(auditDir, `${runWithJob}.jsonl`);
      fs.writeFileSync(jobAuditFile, JSON.stringify({ runId: runWithJob, clientId }) + "\n", "utf8");

      // Insert an active job into jobs table
      db.prepare(`
        insert into jobs (id, client_id, run_id, kind, payload, status, attempts, error, created_at, started_at, finished_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("job-active-1", clientId, runWithJob, "advance", "{}", "running", 1, null, new Date().toISOString(), new Date().toISOString(), null);

      store.createLead({
        id: "lead-with-job",
        clientId,
        userSub: null,
        name: "Job User",
        email: "job@example.com",
        idea: "Active job idea",
        source: "eval",
        runId: runWithJob,
        createdAt: new Date().toISOString(),
      });

      const delJobLeadRes = store.deleteLead(clientId, "lead-with-job", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delJobLeadRes, false, "Must fail closed while linked run has an active running job");
      assert.ok(db.prepare("select * from projects where project_id = ?").get(runWithJob), "Project must not be deleted while job is running");

      // Transition job to 'done' and retry deletion
      db.prepare("update jobs set status = 'done', finished_at = ? where id = 'job-active-1'").run(new Date().toISOString());

      const retryJobRes = store.retryFailedDeletionRequests({ auditDir });
      assert.equal(retryJobRes.succeeded, 1, "Retry should succeed once job is finished");
      assert.equal(db.prepare("select * from projects where project_id = ?").get(runWithJob), undefined, "Project should be deleted after job finishes");
      assert.equal(fs.existsSync(jobAuditFile), false, "Audit file should be deleted after job finishes");

      // 5. Run lock coordination
      const runLocked = "run-locked-coordination";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runLocked, new Date().toISOString(), "Locked Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runLocked, clientId }));

      const lockedAuditFile = path.join(auditDir, `${runLocked}.jsonl`);
      fs.writeFileSync(lockedAuditFile, JSON.stringify({ runId: runLocked, clientId }) + "\n", "utf8");

      store.createLead({
        id: "lead-locked",
        clientId,
        userSub: null,
        name: "Locked User",
        email: "locked@example.com",
        idea: "Locked run idea",
        source: "eval",
        runId: runLocked,
        createdAt: new Date().toISOString(),
      });

      // Acquire run lock
      const releaseLock = tryAcquireRunLock(runLocked);
      assert.ok(releaseLock, "Should acquire run lock");

      const delLockedRes = store.deleteLead(clientId, "lead-locked", {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delLockedRes, false, "Must fail closed while run lock is held");
      assert.ok(db.prepare("select * from projects where project_id = ?").get(runLocked), "Project must not be deleted while lock is held");

      // Release lock and retry
      releaseLock();
      const retryLockRes = store.retryFailedDeletionRequests({ auditDir });
      assert.equal(retryLockRes.succeeded, 1, "Retry should succeed once lock is released");
      assert.equal(db.prepare("select * from projects where project_id = ?").get(runLocked), undefined, "Project should be deleted after lock released");

      // 6. Restart recovery: pending deletion requests are resumed on constructor
      const runRestart = "run-restart-recovery";
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runRestart, new Date().toISOString(), "Restart Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runRestart, clientId }));

      const restartAuditFile = path.join(auditDir, `${runRestart}.jsonl`);
      fs.writeFileSync(restartAuditFile, JSON.stringify({ runId: runRestart, clientId }) + "\n", "utf8");

      store.createLead({
        id: "lead-restart",
        clientId,
        userSub: null,
        name: "Restart User",
        email: "restart@example.com",
        idea: "Restart idea",
        source: "eval",
        runId: runRestart,
        createdAt: new Date().toISOString(),
      });

      // Insert an unexecuted pending request simulating a crash before execution
      const reqId = "req-crash-sim-1";
      db.prepare(`
        insert into lead_deletion_requests (id, client_id, lead_id, run_id, delete_linked_run, status, attempts, error, action, created_at, updated_at, completed_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reqId, clientId, "lead-restart", runRestart, 1, "pending", 0, null, "delete", new Date().toISOString(), new Date().toISOString(), null);

      // Construct a new SqliteLeadStore instance (simulating app restart)
      const restartedStore = new SqliteLeadStore(db);
      const completedReq = restartedStore.getDeletionRequest(reqId);
      assert.equal(completedReq?.status, "completed", "Pending request must be completed on restart");
      assert.equal(restartedStore.getLead(clientId, "lead-restart"), null, "Lead must be purged after restart recovery");
      assert.equal(db.prepare("select * from projects where project_id = ?").get(runRestart), undefined, "Run must be purged after restart recovery");
      assert.equal(fs.existsSync(restartAuditFile), false, "Audit file must be purged after restart recovery");
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Finding 1: Queued withRunLock operation ordering and coordination", async () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-finding1-"));
    const dbPath = path.join(dir, "finding1.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    const store = new SqliteLeadStore(db);
    const clientId = "client-finding1";
    const runId = "run-coord-ordering";

    try {
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runId, new Date().toISOString(), "Coord Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runId, clientId }));
      const auditFile = path.join(auditDir, `${runId}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId, clientId }) + "\n", "utf8");

      store.createLead({
        id: "lead-coord-1",
        clientId,
        userSub: null,
        name: "Coord User",
        email: "coord@example.com",
        idea: "Coord idea",
        source: "eval",
        runId,
        createdAt: new Date().toISOString(),
      });

      const events: string[] = [];
      let resolveOp1: () => void = () => {};
      const op1Barrier = new Promise<void>((res) => { resolveOp1 = res; });
      let op1Started: () => void = () => {};
      const op1StartedBarrier = new Promise<void>((res) => { op1Started = res; });

      // Start op1
      const p1 = withRunLock(runId, async () => {
        events.push("op1-start");
        op1Started();
        await op1Barrier;
        events.push("op1-end");
      });

      // Queue op2 behind op1
      const p2 = withRunLock(runId, async () => {
        events.push("op2-start");
        const prj = db.prepare("select project_id from projects where project_id = ?").get(runId);
        assert.ok(prj, "Queued op2 must run before project is deleted!");
        events.push("op2-end");
      });

      // Wait until op1 starts running
      await op1StartedBarrier;

      // While op1 is active and op2 is queued:
      assert.equal(isRunLocked(runId), true, "Run must report locked when active or queued");
      assert.equal(tryAcquireRunLock(runId), null, "tryAcquireRunLock must fail closed while queued operations exist");

      // Attempt deletion while active and queued operations are in flight: must fail closed!
      const delWhileActive = store.deleteLead(clientId, "lead-coord-1", { deleteLinkedRun: true, auditDir });
      assert.equal(delWhileActive, false, "deleteLead must fail closed while operations are active or queued");
      events.push("deletion-failed-closed-while-busy");

      // Unblock op1
      resolveOp1();

      await Promise.all([p1, p2]);

      // Now that active and queued operations finished, retry deletion
      const retryDel = store.retryFailedDeletionRequests({ auditDir });
      assert.equal(retryDel.succeeded, 1, "Retry deletion must succeed once operations complete");
      events.push("deletion-completed");

      // Queue op3 after deletion: must be rejected because run is deleted!
      let op3Error: Error | null = null;
      try {
        await withRunLock(runId, async () => {
          events.push("op3-ran");
        });
      } catch (err) {
        op3Error = err as Error;
      }
      assert.ok(op3Error, "Op3 queued after deletion must reject");
      assert.match(op3Error.message, /has been deleted/);
      assert.equal(isRunDeleted(runId), true);

      assert.deepEqual(events, [
        "op1-start",
        "deletion-failed-closed-while-busy",
        "op1-end",
        "op2-start",
        "op2-end",
        "deletion-completed",
      ]);
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      resetRunLocksForTesting();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Finding 2: Durable step machine failure after every step and recovery after restart", () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-finding2-"));
    const dbPath = path.join(dir, "finding2.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    const clientId = "client-step-recovery";

    try {
      const stepsToTest: Array<{
        name: string;
        step: "ownership_verified" | "project_deleted" | "jobs_deleted" | "audit_deleted" | "lead_deleted";
        setup: (runId: string, leadId: string) => void;
        verifyBeforeRestart: (runId: string, leadId: string) => void;
      }> = [
        {
          name: "fail after ownership_verified",
          step: "ownership_verified",
          setup: (runId, leadId) => {
            db.prepare(`
              insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(clientId, runId, new Date().toISOString(), "Step Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runId, clientId }));
            fs.writeFileSync(path.join(auditDir, `${runId}.jsonl`), JSON.stringify({ runId, clientId }) + "\n", "utf8");
            db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, run_id, created_at) values (?, ?, null, 'User', 'u@test.com', 'idea', 'eval', ?, ?)`).run(leadId, clientId, runId, new Date().toISOString());
          },
          verifyBeforeRestart: (runId) => {
            assert.ok(db.prepare("select project_id from projects where project_id = ?").get(runId));
          },
        },
        {
          name: "fail after project_deleted (project is gone, must not fail ownership check on retry)",
          step: "project_deleted",
          setup: (runId, leadId) => {
            fs.writeFileSync(path.join(auditDir, `${runId}.jsonl`), JSON.stringify({ runId, clientId }) + "\n", "utf8");
            db.prepare(`insert into jobs (id, client_id, run_id, kind, payload, status, created_at) values (?, ?, ?, 'advance', '{}', 'done', ?)`).run(`job-${runId}`, clientId, runId, new Date().toISOString());
            db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, run_id, created_at) values (?, ?, null, 'User', 'u@test.com', 'idea', 'eval', ?, ?)`).run(leadId, clientId, runId, new Date().toISOString());
          },
          verifyBeforeRestart: (runId) => {
            assert.equal(db.prepare("select project_id from projects where project_id = ?").get(runId), undefined);
            assert.ok(db.prepare("select id from jobs where run_id = ?").get(runId));
            assert.ok(fs.existsSync(path.join(auditDir, `${runId}.jsonl`)));
          },
        },
        {
          name: "fail after jobs_deleted",
          step: "jobs_deleted",
          setup: (runId, leadId) => {
            fs.writeFileSync(path.join(auditDir, `${runId}.jsonl`), JSON.stringify({ runId, clientId }) + "\n", "utf8");
            db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, run_id, created_at) values (?, ?, null, 'User', 'u@test.com', 'idea', 'eval', ?, ?)`).run(leadId, clientId, runId, new Date().toISOString());
          },
          verifyBeforeRestart: (runId) => {
            assert.ok(fs.existsSync(path.join(auditDir, `${runId}.jsonl`)));
          },
        },
        {
          name: "fail after audit_deleted",
          step: "audit_deleted",
          setup: (runId, leadId) => {
            db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, run_id, created_at) values (?, ?, null, 'User', 'u@test.com', 'idea', 'eval', ?, ?)`).run(leadId, clientId, runId, new Date().toISOString());
          },
          verifyBeforeRestart: (runId, leadId) => {
            assert.ok(db.prepare("select id from leads where id = ?").get(leadId));
          },
        },
        {
          name: "fail after lead_deleted (system audit remaining)",
          step: "lead_deleted",
          setup: (runId, leadId) => {
            db.prepare(`insert into lead_deletions (id, client_id, lead_id, run_id, deleted_at, action) values (?, ?, ?, ?, ?, 'delete')`).run(`del-${leadId}`, clientId, leadId, runId, new Date().toISOString());
          },
          verifyBeforeRestart: (runId, leadId) => {
            assert.equal(db.prepare("select id from leads where id = ?").get(leadId), undefined);
          },
        },
      ];

      for (let i = 0; i < stepsToTest.length; i++) {
        const testCase = stepsToTest[i]!;
        const runId = `run-step-test-${i}`;
        const leadId = `lead-step-test-${i}`;
        const reqId = `req-step-test-${i}`;

        testCase.setup(runId, leadId);
        testCase.verifyBeforeRestart(runId, leadId);

        db.prepare(`
          insert into lead_deletion_requests (
            id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at
          ) values (?, ?, ?, ?, 1, 'failed', ?, 1, 'Simulated failure', 'delete', ?, ?, null)
        `).run(reqId, clientId, leadId, runId, testCase.step, new Date().toISOString(), new Date().toISOString());

        const store = new SqliteLeadStore(db);
        const req = store.getDeletionRequest(reqId);
        assert.equal(req?.status, "completed", `Request for ${testCase.name} must reach completed on restart recovery`);
        assert.equal(req?.step, "completed", `Step for ${testCase.name} must reach completed on restart recovery`);

        assert.equal(db.prepare("select project_id from projects where project_id = ?").get(runId), undefined);
        assert.equal(db.prepare("select id from jobs where run_id = ?").get(runId), undefined);
        assert.equal(fs.existsSync(path.join(auditDir, `${runId}.jsonl`)), false);
        assert.equal(db.prepare("select id from leads where id = ?").get(leadId), undefined);
        assert.ok(db.prepare("select id from lead_deletions where lead_id = ?").get(leadId));
      }
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Finding 3: Safe retry mechanism on store startup with maxAttempts limits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-finding3-"));
    const dbPath = path.join(dir, "finding3.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);

    const clientId = "client-retry-bounds";

    try {
      // 1. Create a failed request with attempts = 1 (eligible for retry)
      db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, created_at) values (?, ?, null, 'Eligible', 'e@test.com', 'idea', 'eval', ?)`).run("lead-el-1", clientId, new Date().toISOString());
      db.prepare(`
        insert into lead_deletion_requests (id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at)
        values ('req-el-1', ?, 'lead-el-1', null, 0, 'failed', 'init', 1, 'Temporary failure', 'delete', ?, ?, null)
      `).run(clientId, new Date().toISOString(), new Date().toISOString());

      // 2. Create a poison failed request with attempts = 5 (exceeded maxAttempts)
      db.prepare(`insert into leads (id, client_id, user_sub, name, email, idea, source, created_at) values (?, ?, null, 'Poison', 'p@test.com', 'idea', 'eval', ?)`).run("lead-poison-1", clientId, new Date().toISOString());
      db.prepare(`
        insert into lead_deletion_requests (id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at)
        values ('req-poison-1', ?, 'lead-poison-1', null, 0, 'failed', 'init', 5, 'Permanent failure', 'delete', ?, ?, null)
      `).run(clientId, new Date().toISOString(), new Date().toISOString());

      // Startup store
      const store = new SqliteLeadStore(db);

      // Verify req-el-1 was retried and completed
      const reqEl = store.getDeletionRequest("req-el-1");
      assert.equal(reqEl?.status, "completed", "Eligible request must be retried and completed on startup");
      assert.equal(store.getLead(clientId, "lead-el-1"), null, "Lead must be deleted");

      // Verify req-poison-1 was NOT retried
      const reqPoison = store.getDeletionRequest("req-poison-1");
      assert.equal(reqPoison?.status, "failed", "Poison request must stay failed");
      assert.equal(reqPoison?.attempts, 5, "Poison request attempts must not increase");
      assert.ok(store.getLead(clientId, "lead-poison-1"), "Lead must remain intact");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Finding 4: Corrupt JSON deletion queue fails closed, preserves file, and is not overwritten", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-finding4-"));
    const prevLeadDir = config.leadDir;
    (config as { leadDir: string }).leadDir = dir;

    try {
      const qFile = path.join(dir, ".deletion_requests.json");
      const corruptData = '{"malformed_json_queue": [incomplete';
      fs.writeFileSync(qFile, corruptData, "utf8");

      assert.throws(
        () => new JsonLeadStore(),
        /queue.*corrupt/i,
        "new JsonLeadStore must fail closed on corrupted deletion queue",
      );

      // Verify original file was NOT overwritten with [] or valid JSON!
      assert.equal(fs.readFileSync(qFile, "utf8"), corruptData, "Original corrupt file must not be overwritten");
    } finally {
      (config as { leadDir: string }).leadDir = prevLeadDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Finding 5: Injected errors during remediation and migration surface failures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-finding5-"));
    const dbPath = path.join(dir, "finding5.sqlite");
    const db = new Database(dbPath);
    runMigrations(db);

    const clientId = "client-remediation-fail";

    try {
      // Insert soft-deleted lead directly into leads table
      db.prepare(`
        insert into leads (id, client_id, user_sub, name, email, idea, source, created_at, deleted_at)
        values (?, ?, null, 'Soft Del', 'soft@example.com', 'idea', 'eval', ?, ?)
      `).run("lead-soft-1", clientId, new Date().toISOString(), new Date().toISOString());

      // Inject a trigger to make delete from leads fail!
      db.exec(`
        create trigger inject_delete_error before delete on leads
        begin
          select raise(abort, 'Injected deletion failure');
        end;
      `);

      // Instantiate store: constructor calls remediateSoftDeletedLeads() which must FAIL and THROW!
      assert.throws(
        () => {
          new SqliteLeadStore(db);
        },
        /Injected deletion failure/,
        "Remediation must throw and surface failure when delete fails",
      );

      // Soft-deleted lead must STILL be in leads table (not claimed success)
      const count = (db.prepare("select count(*) as count from leads where deleted_at is not null").get() as { count: number }).count;
      assert.equal(count, 1, "Soft-deleted lead must still remain on failure");

      // Drop trigger and re-run: succeeds!
      db.exec("drop trigger inject_delete_error;");
      const store = new SqliteLeadStore(db);
      const afterCount = (db.prepare("select count(*) as count from leads where deleted_at is not null").get() as { count: number }).count;
      assert.equal(afterCount, 0, "Soft-deleted lead must be purged after trigger dropped");
      assert.ok(store.getDeletionRecord(clientId, "lead-soft-1"), "Deletion audit record must be recorded");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Error sanitization: Error messages never reveal secrets or personal data", () => {
    const rawError = "Failed deleting lead for alice@example.com (phone: +1-555-867-5309). Auth token: Bearer my-secret-jwt-token-12345, ApiKey: jnt_live_sec_1234567890abcdef1234567890abcdef. File at C:\\Users\\Administrator\\secrets.txt";
    const sanitized = sanitizeErrorMessage(rawError);

    assert.equal(sanitized, "Lead deletion failed closed. Retry after operator review.");
    assert.equal(sanitized.includes("alice@example.com"), false, "Email must not be present");
    assert.equal(sanitized.includes("+1-555-867-5309"), false, "Phone must not be present");
    assert.equal(sanitized.includes("my-secret-jwt-token-12345"), false, "Bearer token must not be present");
    assert.equal(sanitized.includes("jnt_live_sec_1234567890abcdef1234567890abcdef"), false, "API key must not be present");
    assert.equal(sanitized.includes("Administrator"), false, "User path must not be present");
  });

  it("Issue 1: SqliteProjectStore startup recovery uses owning project store and deletes linked files in configured projectDir", () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-issue1-"));
    const customProjectDir = path.join(dir, "custom-project-files");
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    const clientId = "client-issue1";
    const runId = "run-issue1-custom-files";

    let initialStore: SqliteProjectStore | null = null;
    let restartedStore: SqliteProjectStore | null = null;

    try {
      // 1. Initial setup using SqliteProjectStore with custom projectDir
      initialStore = new SqliteProjectStore(dbPath, {
        projectDir: customProjectDir,
        skipImport: true,
      });

      const project = createProject(clientId, "Issue 1 Project");
      project.id = runId;
      initialStore.saveProject(project);

      // Write an artifact file and a source content file into customProjectDir
      const artifactPath = initialStore.writeArtifactFile(clientId, runId, {
        stage: "intake",
        kind: "brief",
        title: "Intake Brief",
        version: 1,
        content: "confidential project brief",
        createdAt: new Date().toISOString(),
      });
      const sourcePath = initialStore.writeSourceContentFile(
        clientId,
        runId,
        {
          id: "source-1",
          clientId,
          url: "https://example.com",
          title: "source",
          retrievedAt: new Date().toISOString(),
          contentHash: "hash-123",
          qualityScore: 1,
        },
        "confidential source text",
      );

      // Write audit log
      const auditFile = path.join(auditDir, `${runId}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId, clientId }) + "\n", "utf8");

      // Verify files were created inside customProjectDir
      assert.ok(fs.existsSync(artifactPath), "Artifact file must exist in customProjectDir");
      assert.ok(fs.existsSync(sourcePath), "Source file must exist in customProjectDir");
      assert.equal(artifactPath.startsWith(customProjectDir), true);
      assert.equal(sourcePath.startsWith(customProjectDir), true);

      // Create a lead linked to this run
      initialStore.createLead({
        id: "lead-issue1-1",
        clientId,
        userSub: null,
        name: "Founder",
        email: "founder@custom.test",
        idea: "Custom dir idea",
        source: "eval",
        runId,
        createdAt: new Date().toISOString(),
      });

      // Close initialStore before simulating restart
      initialStore.close();
      initialStore = null;

      // Insert a pending deletion request directly into DB (simulating crash before execution)
      const db = new Database(dbPath);
      const reqId = "req-issue1-crash-sim";
      db.prepare(`
        insert into lead_deletion_requests (
          id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at
        ) values (?, ?, ?, ?, 1, 'pending', 'init', 0, null, 'delete', ?, ?, null)
      `).run(reqId, clientId, "lead-issue1-1", runId, new Date().toISOString(), new Date().toISOString());
      db.close();

      // 2. Start up a new SqliteProjectStore with the same custom projectDir
      // The constructor instantiates SqliteLeadStore with projectStore: this
      // and immediately executes startup recovery (processPendingDeletionRequests).
      restartedStore = new SqliteProjectStore(dbPath, {
        projectDir: customProjectDir,
        skipImport: true,
      });

      // Verify the request reached completed
      const req = restartedStore.getDeletionRequest(reqId);
      assert.equal(req?.status, "completed", "Pending request must reach completed on startup");
      assert.equal(req?.step, "completed");

      // Verify SQLite row was deleted
      assert.equal(restartedStore.loadProject(clientId, runId), null, "Project row in SQLite must be deleted");

      // CRITICAL Issue 1 verification:
      // Verify that all artifact and source files in customProjectDir were deleted, NOT left behind!
      assert.equal(fs.existsSync(artifactPath), false, "Artifact file in customProjectDir must be deleted");
      assert.equal(fs.existsSync(sourcePath), false, "Source file in customProjectDir must be deleted");
      assert.equal(
        fs.existsSync(path.join(customProjectDir, clientId, runId)),
        false,
        "Project run folder in customProjectDir must be completely purged",
      );
      assert.equal(fs.existsSync(auditFile), false, "Audit file must be purged");
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      resetRunLocksForTesting();
      initialStore?.close();
      restartedStore?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Issue 2: Failed deletion does not block surviving run, and explicit cancellation / recovery paths work", async () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-issue2-"));
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    const db = new Database(dbPath);
    runMigrations(db);

    const clientId = "client-issue2";
    const runId = "run-surviving-test";
    const leadId = "lead-surviving-test";

    try {
      // 1. Setup project, audit file, and lead
      db.prepare(`
        insert into projects (client_id, project_id, updated_at, title, agent_id, agent_version, status, current_stage, current_stage_status, cost_usd, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clientId, runId, new Date().toISOString(), "Surviving Run", "intake", 1, "active", "intake", "completed", 0.05, new Date().toISOString(), JSON.stringify({ id: runId, clientId }));

      const auditFile = path.join(auditDir, `${runId}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId, clientId }) + "\n", "utf8");

      const store = new SqliteLeadStore(db);
      store.createLead({
        id: leadId,
        clientId,
        userSub: null,
        name: "Surviving User",
        email: "surviving@example.com",
        idea: "Surviving idea",
        source: "eval",
        runId,
        createdAt: new Date().toISOString(),
      });

      // Inject failure on project deletion (Step 2) using a SQLite trigger
      db.exec(`
        create trigger inject_project_delete_fail before delete on projects
        begin
          select raise(abort, 'Injected failure deleting project');
        end;
      `);

      // Attempt deletion: must fail closed on Step 2
      const delResult = store.deleteLead(clientId, leadId, {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delResult, false, "deleteLead must return false when project deletion fails");

      // Verify deletion request exists and is marked failed at ownership_verified
      const failedReqs = store.listDeletionRequests(clientId, "failed");
      const req = failedReqs.find((r) => r.leadId === leadId);
      assert.ok(req, "Failed deletion request must be recorded");
      assert.equal(req.status, "failed");
      assert.equal(req.step, "ownership_verified");

      // Project STILL EXISTS in SQLite
      const projectRow = db.prepare("select project_id from projects where project_id = ?").get(runId);
      assert.ok(projectRow, "Project must still exist after Step 2 failure");

      // CRITICAL Issue 2 verification:
      // Run must NOT be marked deleted, and must NOT be locked!
      assert.equal(isRunDeleted(runId), false, "Run must NOT be marked deleted when project deletion fails");
      assert.equal(isRunLocked(runId), false, "Run must NOT be locked after failed deletion");

      // Operations on the surviving run must execute normally!
      const opResult = await withRunLock(runId, async () => {
        return "surviving-run-executed-ok";
      });
      assert.equal(opResult, "surviving-run-executed-ok", "Surviving run must remain operable");

      // 2. Simulate request reaching attempt limit (5 attempts)
      db.prepare("update lead_deletion_requests set attempts = 5 where id = ?").run(req.id);
      const autoRetryRes = store.retryFailedDeletionRequests({ auditDir });
      assert.equal(autoRetryRes.processed, 0, "Requests reaching maxAttempts must not be retried automatically");

      // The surviving run must STILL be operable
      const opResult2 = await withRunLock(runId, async () => {
        return "still-operable";
      });
      assert.equal(opResult2, "still-operable");

      // 3. Test Explicit Cancellation Path
      // Cancel the deletion request: operator decides not to delete this lead/run
      const cancelSuccess = store.cancelDeletionRequest(req.id);
      assert.equal(cancelSuccess, true, "Explicit cancellation must succeed");

      const cancelledReq = store.getDeletionRequest(req.id);
      assert.equal(cancelledReq?.status, "cancelled", "Request status must be cancelled");
      assert.equal(isRunDeleted(runId), false, "Run must remain active after cancellation");

      // Operations continue to succeed
      const opResult3 = await withRunLock(runId, async () => {
        return "still-operable-after-cancel";
      });
      assert.equal(opResult3, "still-operable-after-cancel");

      // Cancelling already cancelled or completed request returns false
      assert.equal(store.cancelDeletionRequest(req.id), false);

      // 4. Test Explicit Recovery Path
      // Drop the trigger that caused failure
      db.exec("drop trigger inject_project_delete_fail;");

      // Operator triggers explicit retry on this request
      const retrySuccess = store.retryDeletionRequest(req.id, { force: true, auditDir });
      assert.equal(retrySuccess, true, "Explicit retry with force must succeed");

      const completedReq = store.getDeletionRequest(req.id);
      assert.equal(completedReq?.status, "completed", "Request must reach completed after recovery");

      // Now the project is truly deleted
      assert.equal(db.prepare("select project_id from projects where project_id = ?").get(runId), undefined);
      assert.equal(fs.existsSync(auditFile), false);
      assert.equal(isRunDeleted(runId), true, "Run is now marked deleted");

      // New operations on the deleted run now reject
      await assert.rejects(
        withRunLock(runId, async () => {}),
        /deleted/,
      );
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      resetRunLocksForTesting();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Cancellation refuses when removal has begun, including stop immediately after project deletion before step is saved (SQLite and JSON stores)", async () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-stop-after-del-"));
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;

    let store: SqliteProjectStore | null = null;
    const prevLeadDir = config.leadDir;
    const prevProjectDir = config.projectDir;

    try {
      // ---------------------------------------------------------
      // Part 1: SQLite Store
      // ---------------------------------------------------------
      store = new SqliteProjectStore(dbPath, {
        projectDir: dir,
        skipImport: true,
      });

      const clientId = "client-stop-sqlite";
      const runId = "run-stop-sqlite";
      const leadId = "lead-stop-sqlite";

      const project = createProject(clientId, "Stop After Project Delete Project");
      project.id = runId;
      store.saveProject(project);

      const artifactPath = store.writeArtifactFile(clientId, runId, {
        stage: "intake",
        kind: "brief",
        title: "Brief",
        version: 1,
        content: "confidential brief content",
        createdAt: new Date().toISOString(),
      });
      assert.ok(fs.existsSync(artifactPath), "Artifact file must exist initially");

      const auditFile = path.join(auditDir, `${runId}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId, clientId }) + "\n", "utf8");

      store.createLead({
        id: leadId,
        clientId,
        userSub: null,
        name: "Founder",
        email: "founder@stop-sim.test",
        idea: "Stop simulation idea",
        source: "eval",
        runId,
        createdAt: new Date().toISOString(),
      });

      // Install a SQLite trigger that crashes immediately after project deletion
      // when Step 2 tries to record status = 'processing' and step = 'project_deleted' in lead_deletion_requests
      const rawDb = (store as any).db as Database.Database;
      rawDb.exec(`
        create trigger stop_after_project_deleted before update on lead_deletion_requests
        when new.status = 'processing' and new.step = 'project_deleted'
        begin
          select raise(abort, 'Simulated crash immediately after project deletion');
        end;
      `);

      // Attempt deletion: Step 2 deletes project and files, then crashes before saving 'project_deleted'
      const delResult = store.deleteLead(clientId, leadId, {
        deleteLinkedRun: true,
        auditDir,
      });
      assert.equal(delResult, false, "deleteLead must fail closed when trigger aborts saving step");

      // Verify the simulated crash state:
      // Request step in DB is STILL 'ownership_verified' because 'project_deleted' was aborted!
      const failedReqs = store.listDeletionRequests(clientId, "failed");
      const failedReq = failedReqs.find((r) => r.leadId === leadId);
      assert.ok(failedReq, "Failed deletion request must be recorded");
      assert.equal(failedReq.status, "failed");
      assert.equal(failedReq.step, "ownership_verified", "Step must still be ownership_verified");

      // BUT the project and linked files have ALREADY been deleted!
      assert.equal(store.loadProject(clientId, runId), null, "Project row in SQLite must already be deleted");
      assert.equal(fs.existsSync(artifactPath), false, "Artifact file must already be deleted");

      // AND the lead still exists in SQLite
      assert.ok(store.getLead(clientId, leadId), "Lead must still exist in SQLite");

      // CRITICAL VERIFICATION:
      // An operator attempts to cancel the request while step is 'ownership_verified'.
      // Cancellation MUST BE REFUSED because project removal has already begun!
      const cancelResult = store.cancelDeletionRequest(failedReq.id);
      assert.equal(cancelResult, false, "cancelDeletionRequest MUST return false when project is gone!");

      // Request must NOT be marked cancelled
      const reqAfterCancel = store.getDeletionRequest(failedReq.id);
      assert.notEqual(reqAfterCancel?.status, "cancelled", "Request status must not be cancelled");
      assert.equal(reqAfterCancel?.step, "ownership_verified");

      // Operations on the deleted run must be rejected
      await assert.rejects(
        withRunLock(runId, async () => {}),
        /deleted/,
        "Operations on deleted run must reject",
      );

      // Now verify recovery: drop the trigger and retry
      rawDb.exec("drop trigger stop_after_project_deleted;");

      const retryResult = store.retryDeletionRequest(failedReq.id, { force: true, auditDir });
      assert.equal(retryResult, true, "Retry must succeed after fault resolution");

      const completedReq = store.getDeletionRequest(failedReq.id);
      assert.equal(completedReq?.status, "completed", "Request must reach completed status");
      assert.equal(completedReq?.step, "completed");

      // Lead is now purged
      assert.equal(store.getLead(clientId, leadId), null, "Lead must be purged after recovery");
      assert.equal(fs.existsSync(auditFile), false, "Audit file must be purged");

      // ---------------------------------------------------------
      // Part 2: JSON Store
      // ---------------------------------------------------------
      const jsonDir = path.join(dir, "json-store");
      fs.mkdirSync(jsonDir, { recursive: true });
      (config as { leadDir: string }).leadDir = jsonDir;
      (config as { projectDir: string }).projectDir = jsonDir;

      const jsonProjectStore = new JsonProjectStore(jsonDir);
      const jsonLeadStore = new JsonLeadStore({ projectStore: jsonProjectStore });

      const jsonClientId = "client-stop-json";
      const jsonRunId = "run-stop-json";
      const jsonLeadId = "lead-stop-json";

      const jsonProject = createProject(jsonClientId, "JSON Stop Project");
      jsonProject.id = jsonRunId;
      jsonProjectStore.saveProject(jsonProject);

      const jsonArtifactPath = jsonProjectStore.writeArtifactFile(jsonClientId, jsonRunId, {
        stage: "intake",
        kind: "brief",
        title: "JSON Brief",
        version: 1,
        content: "json confidential content",
        createdAt: new Date().toISOString(),
      });
      assert.ok(fs.existsSync(jsonArtifactPath));

      const jsonAuditFile = path.join(auditDir, `${jsonRunId}.jsonl`);
      fs.writeFileSync(jsonAuditFile, JSON.stringify({ runId: jsonRunId, clientId: jsonClientId }) + "\n", "utf8");

      jsonLeadStore.createLead({
        id: jsonLeadId,
        clientId: jsonClientId,
        userSub: null,
        name: "JSON Founder",
        email: "jsonfounder@test.com",
        idea: "JSON idea",
        source: "eval",
        runId: jsonRunId,
        createdAt: new Date().toISOString(),
      });

      // Create an intercepting ProjectStore that deletes the project on disk,
      // then throws an error simulating a stop before writeDeletionRequests('project_deleted')
      const crashingProjectStore: ProjectStore = {
        saveProject: (p) => jsonProjectStore.saveProject(p),
        loadProject: (c, id) => jsonProjectStore.loadProject(c, id),
        listProjects: (q) => jsonProjectStore.listProjects(q),
        getClientDailyIdeationSpend: (c, d) => jsonProjectStore.getClientDailyIdeationSpend(c, d),
        addClientDailyIdeationSpend: (c, d, u) => jsonProjectStore.addClientDailyIdeationSpend(c, d, u),
        getClientDailyGatewaySpend: (c, d) => jsonProjectStore.getClientDailyGatewaySpend(c, d),
        addClientDailyGatewaySpend: (c, d, u) => jsonProjectStore.addClientDailyGatewaySpend(c, d, u),
        writeArtifactFile: (c, id, a) => jsonProjectStore.writeArtifactFile(c, id, a),
        writeSourceContentFile: (c, id, s, ct) => jsonProjectStore.writeSourceContentFile(c, id, s, ct),
        deleteProject: (cId, pId) => {
          jsonProjectStore.deleteProject(cId, pId);
          throw new Error("Simulated stop immediately after project deletion in JSON path");
        },
      };

      const jsonDelResult = jsonLeadStore.deleteLead(jsonClientId, jsonLeadId, {
        deleteLinkedRun: true,
        projectStore: crashingProjectStore,
        auditDir,
      });
      assert.equal(jsonDelResult, false);

      // Verify the request in JSON queue says 'ownership_verified'
      const jsonFailedReqs = jsonLeadStore.listDeletionRequests(jsonClientId, "failed");
      const jsonFailedReq = jsonFailedReqs.find((r) => r.leadId === jsonLeadId);
      assert.ok(jsonFailedReq);
      assert.equal(jsonFailedReq.status, "failed");
      assert.equal(jsonFailedReq.step, "ownership_verified");

      // Verify the project and artifacts were deleted on disk
      assert.equal(jsonProjectStore.loadProject(jsonClientId, jsonRunId), null);
      assert.equal(fs.existsSync(jsonArtifactPath), false);

      // Verify lead still exists
      assert.ok(jsonLeadStore.getLead(jsonClientId, jsonLeadId));

      // CRITICAL JSON VERIFICATION:
      // Cancellation must be refused because project removal has begun!
      const jsonCancelResult = jsonLeadStore.cancelDeletionRequest(jsonFailedReq.id, {
        projectStore: jsonProjectStore,
      });
      assert.equal(jsonCancelResult, false, "cancelDeletionRequest in JSON store must return false!");

      const jsonReqAfterCancel = jsonLeadStore.getDeletionRequest(jsonFailedReq.id);
      assert.notEqual(jsonReqAfterCancel?.status, "cancelled");
      assert.equal(jsonReqAfterCancel?.step, "ownership_verified");

      // Verify recovery in JSON path
      const jsonRetryResult = jsonLeadStore.retryDeletionRequest(jsonFailedReq.id, {
        force: true,
        projectStore: jsonProjectStore,
        auditDir,
      });
      assert.equal(jsonRetryResult, true);

      const jsonCompletedReq = jsonLeadStore.getDeletionRequest(jsonFailedReq.id);
      assert.equal(jsonCompletedReq?.status, "completed");
      assert.equal(jsonCompletedReq?.step, "completed");
      assert.equal(jsonLeadStore.getLead(jsonClientId, jsonLeadId), null);
      assert.equal(fs.existsSync(jsonAuditFile), false);
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      (config as { leadDir: string }).leadDir = prevLeadDir;
      (config as { projectDir: string }).projectDir = prevProjectDir;
      resetRunLocksForTesting();
      store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Cancellation succeeds for an intact run that has artifacts directly in the run folder (SQLite and JSON stores)", async () => {
    resetRunLocksForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-intact-artifacts-"));
    const dbPath = path.join(dir, "store.sqlite");
    const auditDir = path.join(dir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const prevAuditDir = config.auditDir;
    (config as { auditDir: string }).auditDir = auditDir;
    const prevLeadDir = config.leadDir;
    const prevProjectDir = config.projectDir;

    let store: SqliteProjectStore | null = null;

    try {
      // ---------------------------------------------------------
      // 1. SQLite Store: Intact run with artifacts in run folder
      // ---------------------------------------------------------
      store = new SqliteProjectStore(dbPath, {
        projectDir: dir,
        skipImport: true,
      });

      const clientId = "client-intact-sqlite";
      const runId = "run-intact-sqlite";
      const leadId = "lead-intact-sqlite";

      const project = createProject(clientId, "Intact Run With Artifacts");
      project.id = runId;

      const artifact = {
        stage: "intake" as const,
        kind: "brief",
        title: "Brief",
        version: 1,
        content: "intact brief content directly in run folder",
        createdAt: new Date().toISOString(),
      };
      // writeArtifactFile writes directly into the run folder: <projectDir>/<clientId>/<runId>/intake-brief-v1.md
      const artifactPath = store.writeArtifactFile(clientId, runId, artifact);
      assert.ok(fs.existsSync(artifactPath), "Artifact file must exist on disk");
      assert.equal(
        artifactPath,
        path.join(dir, clientId, runId, "intake-brief-v1.md"),
        "Artifact must be written directly inside run folder, not an artifacts subfolder",
      );

      // Attach artifact to project definition and save
      project.stages.intake!.artifacts = [artifact];
      store.saveProject(project);

      const auditFile = path.join(auditDir, `${runId}.jsonl`);
      fs.writeFileSync(auditFile, JSON.stringify({ runId, clientId }) + "\n", "utf8");

      store.createLead({
        id: leadId,
        clientId,
        userSub: null,
        name: "Intact Founder",
        email: "intact@example.com",
        idea: "Intact project idea",
        source: "eval",
        runId,
        createdAt: new Date().toISOString(),
      });

      // Insert a failed deletion request before project deletion occurred (e.g. transient failure)
      const reqId = "req-intact-sqlite";
      const rawDb = (store as any).db as Database.Database;
      rawDb.prepare(`
        insert into lead_deletion_requests (
          id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at
        ) values (?, ?, ?, ?, 1, 'failed', 'ownership_verified', 1, 'Temporary failure', 'delete', ?, ?, null)
      `).run(reqId, clientId, leadId, runId, new Date().toISOString(), new Date().toISOString());

      // Verify the run and its files are 100% intact before cancellation
      assert.ok(store.loadProject(clientId, runId), "Project must exist in SQLite");
      assert.ok(fs.existsSync(artifactPath), "Artifact file must exist directly in run folder");
      assert.ok(store.getLead(clientId, leadId), "Lead must exist in SQLite");

      // Operator cancels the deletion request on this intact run:
      // Cancellation MUST succeed because the project and all its artifact files exist!
      const cancelResult = store.cancelDeletionRequest(reqId);
      assert.equal(cancelResult, true, "Cancellation must succeed for an intact run with artifacts");

      const cancelledReq = store.getDeletionRequest(reqId);
      assert.equal(cancelledReq?.status, "cancelled");

      // Verify that all data remains completely intact after cancellation
      assert.ok(store.loadProject(clientId, runId), "Project must remain intact after cancellation");
      assert.ok(fs.existsSync(artifactPath), "Artifact must remain intact after cancellation");
      assert.ok(store.getLead(clientId, leadId), "Lead must remain intact after cancellation");

      // Operations on the run must continue to succeed
      const opResult = await withRunLock(runId, async () => "operable-after-cancel");
      assert.equal(opResult, "operable-after-cancel");

      const sqliteFallbackDir = path.join(dir, clientId, runId, "artifacts");
      fs.mkdirSync(sqliteFallbackDir);
      fs.copyFileSync(artifactPath, path.join(sqliteFallbackDir, path.basename(artifactPath)));
      fs.rmSync(artifactPath);
      const sqliteMissingReqId = "req-missing-direct-sqlite";
      rawDb.prepare(`
        insert into lead_deletion_requests (
          id, client_id, lead_id, run_id, delete_linked_run, status, step, attempts, error, action, created_at, updated_at, completed_at
        ) values (?, ?, ?, ?, 1, 'failed', 'ownership_verified', 1, null, 'delete', ?, ?, null)
      `).run(sqliteMissingReqId, clientId, leadId, runId, new Date().toISOString(), new Date().toISOString());
      assert.equal(store.cancelDeletionRequest(sqliteMissingReqId), false);
      assert.equal(store.getDeletionRequest(sqliteMissingReqId)?.status, "failed");

      // ---------------------------------------------------------
      // 2. JSON Store: Intact run with artifacts in run folder
      // ---------------------------------------------------------
      const jsonDir = path.join(dir, "json-intact");
      fs.mkdirSync(jsonDir, { recursive: true });
      (config as { leadDir: string }).leadDir = jsonDir;
      (config as { projectDir: string }).projectDir = jsonDir;

      const jsonProjectStore = new JsonProjectStore(jsonDir);
      const jsonLeadStore = new JsonLeadStore({ projectStore: jsonProjectStore });

      const jsonClientId = "client-intact-json";
      const jsonRunId = "run-intact-json";
      const jsonLeadId = "lead-intact-json";

      const jsonProject = createProject(jsonClientId, "JSON Intact Project");
      jsonProject.id = jsonRunId;

      const jsonArtifact = {
        stage: "intake" as const,
        kind: "brief",
        title: "JSON Brief",
        version: 1,
        content: "json intact brief content directly in run folder",
        createdAt: new Date().toISOString(),
      };
      const jsonArtifactPath = jsonProjectStore.writeArtifactFile(jsonClientId, jsonRunId, jsonArtifact);
      assert.ok(fs.existsSync(jsonArtifactPath));
      assert.equal(
        jsonArtifactPath,
        path.join(jsonDir, jsonClientId, jsonRunId, "intake-brief-v1.md"),
      );

      jsonProject.stages.intake!.artifacts = [jsonArtifact];
      jsonProjectStore.saveProject(jsonProject);

      const jsonAuditFile = path.join(auditDir, `${jsonRunId}.jsonl`);
      fs.writeFileSync(jsonAuditFile, JSON.stringify({ runId: jsonRunId, clientId: jsonClientId }) + "\n", "utf8");

      jsonLeadStore.createLead({
        id: jsonLeadId,
        clientId: jsonClientId,
        userSub: null,
        name: "JSON Intact Founder",
        email: "jsonintact@example.com",
        idea: "JSON intact idea",
        source: "eval",
        runId: jsonRunId,
        createdAt: new Date().toISOString(),
      });

      // Insert a pending deletion request into the JSON queue
      const jsonReqId = "req-intact-json";
      const queueFile = path.join(jsonDir, ".deletion_requests.json");
      fs.writeFileSync(
        queueFile,
        JSON.stringify([
          {
            id: jsonReqId,
            clientId: jsonClientId,
            leadId: jsonLeadId,
            runId: jsonRunId,
            deleteLinkedRun: true,
            status: "failed",
            step: "ownership_verified",
            attempts: 1,
            error: "Temporary error",
            action: "delete",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: null,
          },
        ], null, 2),
        "utf8",
      );

      // Verify intact before cancellation
      assert.ok(jsonProjectStore.loadProject(jsonClientId, jsonRunId));
      assert.ok(fs.existsSync(jsonArtifactPath));
      assert.ok(jsonLeadStore.getLead(jsonClientId, jsonLeadId));

      // Operator cancels deletion request on intact JSON run
      const jsonCancelResult = jsonLeadStore.cancelDeletionRequest(jsonReqId, {
        projectStore: jsonProjectStore,
      });
      assert.equal(jsonCancelResult, true, "Cancellation must succeed for intact JSON run with artifacts");

      const jsonCancelledReq = jsonLeadStore.getDeletionRequest(jsonReqId);
      assert.equal(jsonCancelledReq?.status, "cancelled");

      // Verify everything remains intact
      assert.ok(jsonProjectStore.loadProject(jsonClientId, jsonRunId));
      assert.ok(fs.existsSync(jsonArtifactPath));
      assert.ok(jsonLeadStore.getLead(jsonClientId, jsonLeadId));

      const jsonFallbackDir = path.join(jsonDir, jsonClientId, jsonRunId, "artifacts");
      fs.mkdirSync(jsonFallbackDir);
      fs.copyFileSync(jsonArtifactPath, path.join(jsonFallbackDir, path.basename(jsonArtifactPath)));
      fs.rmSync(jsonArtifactPath);
      const jsonMissingReqId = "req-missing-direct-json";
      const jsonQueue = JSON.parse(fs.readFileSync(queueFile, "utf8")) as Array<Record<string, unknown>>;
      jsonQueue.push({
        ...jsonQueue[0],
        id: jsonMissingReqId,
        status: "failed",
        step: "ownership_verified",
      });
      fs.writeFileSync(queueFile, JSON.stringify(jsonQueue), "utf8");
      assert.equal(jsonLeadStore.cancelDeletionRequest(jsonMissingReqId, { projectStore: jsonProjectStore }), false);
      assert.equal(jsonLeadStore.getDeletionRequest(jsonMissingReqId)?.status, "failed");
    } finally {
      (config as { auditDir: string }).auditDir = prevAuditDir;
      (config as { leadDir: string }).leadDir = prevLeadDir;
      (config as { projectDir: string }).projectDir = prevProjectDir;
      resetRunLocksForTesting();
      store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

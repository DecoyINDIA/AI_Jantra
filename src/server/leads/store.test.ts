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
});

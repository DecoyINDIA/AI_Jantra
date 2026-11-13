import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { createProject } from "../orchestrator.js";
import { SqliteProjectStore } from "./sqlite.js";
import { runMigrations } from "./migrations/index.js";
import { importLegacyJsonData } from "./migrations/importLegacyJson.js";

function getTableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

function getDatabaseTables(db: Database.Database): string[] {
  const rows = db
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

describe("SqliteProjectStore & Migrations (T-015)", () => {
  it("fresh database and upgraded database produce identical schemas", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-schema-test-"));
    try {
      // 1. Fresh database via SqliteProjectStore
      const freshDbPath = join(dir, "fresh.sqlite");
      const freshStore = new SqliteProjectStore(freshDbPath, { skipImport: true });
      const freshDb = new Database(freshDbPath);

      // 2. Upgraded database: start with legacy schema first
      const upgradedDbPath = join(dir, "upgraded.sqlite");
      const upgradedDb = new Database(upgradedDbPath);
      upgradedDb.exec(`
        create table projects (
          client_id text not null,
          project_id text not null,
          updated_at text not null,
          data text not null,
          primary key (client_id, project_id)
        );
        create table api_keys (
          id text primary key,
          key_hash text not null unique,
          prefix text not null,
          client_id text not null,
          subject text not null,
          label text not null,
          created_at text not null,
          last_used_at text,
          revoked_at text
        );
        create table client_daily_ideation_spend (
          client_id text not null,
          day_utc text not null,
          usd real not null,
          primary key (client_id, day_utc)
        );
        create table client_daily_gateway_spend (
          client_id text not null,
          day_utc text not null,
          usd real not null,
          primary key (client_id, day_utc)
        );
      `);

      // Run migrations on upgraded database
      const count = runMigrations(upgradedDb);
      assert(count > 0, "Should apply migrations on upgraded database");

      // Verify identical tables
      const freshTables = getDatabaseTables(freshDb);
      const upgradedTables = getDatabaseTables(upgradedDb);
      assert.deepEqual(freshTables, upgradedTables, "Tables must match between fresh and upgraded");

      // Verify identical columns on every table
      for (const table of freshTables) {
        const freshCols = getTableColumns(freshDb, table);
        const upgradedCols = getTableColumns(upgradedDb, table);
        assert.deepEqual(freshCols, upgradedCols, `Columns on table ${table} must match`);
      }

      // Idempotency: running migrations again applies 0 migrations
      const countAgain = runMigrations(upgradedDb);
      assert.equal(countAgain, 0, "Second migration run should apply 0 migrations");

      freshStore.close();
      freshDb.close();
      upgradedDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills mirrored columns from data blob during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-backfill-test-"));
    try {
      const dbPath = join(dir, "legacy.sqlite");
      const db = new Database(dbPath);
      db.exec(`
        create table projects (
          client_id text not null,
          project_id text not null,
          updated_at text not null,
          data text not null,
          primary key (client_id, project_id)
        );
      `);

      const sampleProject = createProject({
        clientId: "client-test",
        title: "Legacy Project",
        agentId: "planning-pipeline",
      });
      sampleProject.status = "active";
      sampleProject.currentStage = "intake";

      db.prepare("insert into projects (client_id, project_id, updated_at, data) values (?, ?, ?, ?)").run(
        sampleProject.clientId,
        sampleProject.id,
        sampleProject.updatedAt,
        JSON.stringify(sampleProject),
      );

      // Run migrations
      runMigrations(db);

      const row = db
        .prepare("select agent_id, status, title, current_stage from projects where project_id = ?")
        .get(sampleProject.id) as {
        agent_id: string;
        status: string;
        title: string;
        current_stage: string;
      };

      assert.equal(row.agent_id, "planning-pipeline");
      assert.equal(row.status, "active");
      assert.equal(row.title, "Legacy Project");
      assert.equal(row.current_stage, "intake");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listing runs uses mirrored columns without parsing JSON blobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-list-perf-test-"));
    try {
      const dbPath = join(dir, "test.sqlite");
      const store = new SqliteProjectStore(dbPath, { skipImport: true });

      for (let i = 0; i < 5; i++) {
        const p = createProject({
          clientId: "c1",
          title: `Project ${i}`,
          agentId: "planning-pipeline",
        });
        store.saveProject(p);
      }

      // Corrupt the data column to invalid JSON for all rows
      // If listProjects reads the mirrored columns, it will succeed without throwing JSON.parse errors!
      const rawDb = new Database(dbPath);
      rawDb.exec("update projects set data = 'INVALID_JSON_CORRUPTED'");
      rawDb.close();

      const page = store.listProjects({ clientId: "c1" });
      assert.equal(page.items.length, 5);
      assert(page.items[0]?.title.startsWith("Project "));

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports legacy JSON leads and webhooks and renames folders with .imported suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-import-test-"));
    try {
      const leadDir = join(dir, "leads");
      const projectDir = join(dir, "projects");
      const clientLeadDir = join(leadDir, "client-a");
      mkdirSync(clientLeadDir, { recursive: true });

      // Write sample lead
      const sampleLead = {
        id: "lead-123",
        clientId: "client-a",
        name: "Jane Doe",
        email: "jane@example.com",
        idea: "AI Logistics",
        source: "widget",
        createdAt: "2026-03-14T10:00:00Z",
      };
      writeFileSync(join(clientLeadDir, "lead-123.json"), JSON.stringify(sampleLead), "utf8");

      // Write sample webhook
      const clientProjDir = join(projectDir, "client-a");
      mkdirSync(clientProjDir, { recursive: true });
      const sampleWebhooks = [
        {
          id: "wh-1",
          clientId: "client-a",
          url: "https://example.com/webhook",
          events: ["lead.created"],
          createdAt: "2026-03-14T10:00:00Z",
        },
      ];
      writeFileSync(join(clientProjDir, "webhooks.json"), JSON.stringify(sampleWebhooks), "utf8");

      const dbPath = join(dir, "jantra.sqlite");
      const db = new Database(dbPath);
      runMigrations(db);

      // Run import
      const result = importLegacyJsonData(db, { leadDir, projectDir });
      assert.equal(result.leadsImported, 1);
      assert.equal(result.webhooksImported, 1);

      // Check leads in database
      const leadRow = db.prepare("select * from leads where id = ?").get("lead-123") as {
        name: string;
        email: string;
      };
      assert.equal(leadRow.name, "Jane Doe");
      assert.equal(leadRow.email, "jane@example.com");

      // Check webhook in database
      const whRow = db.prepare("select * from webhook_subscriptions where id = ?").get("wh-1") as {
        url: string;
      };
      assert.equal(whRow.url, "https://example.com/webhook");

      // Verify files were renamed to .imported
      assert(existsSync(join(leadDir, "client-a.imported")), "Lead dir must be renamed with .imported suffix");
      assert(!existsSync(clientLeadDir), "Old lead dir must no longer exist");
      assert(existsSync(join(clientProjDir, "webhooks.json.imported")), "Webhooks file must be renamed with .imported");
      assert(!existsSync(join(clientProjDir, "webhooks.json")), "Old webhooks.json must not exist");

      // Idempotency: calling import again imports 0 and succeeds cleanly
      const secondResult = importLegacyJsonData(db, { leadDir, projectDir });
      assert.equal(secondResult.leadsImported, 0);
      assert.equal(secondResult.webhooksImported, 0);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and resolves api_keys with scope and allowed_agents", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-apikey-scope-test-"));
    try {
      const dbPath = join(dir, "keys.sqlite");
      const store = new SqliteProjectStore(dbPath, { skipImport: true });

      const created = store.createApiKey({
        id: "key-1",
        keyHash: "hash-public-key",
        prefix: "jntr_test",
        clientId: "client-scope",
        subject: "web-widget",
        label: "Public Widget Key",
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        scope: "public",
        allowedAgents: ["intake-public"],
      });

      assert.equal(created.scope, "public");
      assert.deepEqual(created.allowedAgents, ["intake-public"]);

      const loaded = store.getApiKeyByHash("hash-public-key");
      assert(loaded);
      assert.equal(loaded.scope, "public");
      assert.deepEqual(loaded.allowedAgents, ["intake-public"]);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

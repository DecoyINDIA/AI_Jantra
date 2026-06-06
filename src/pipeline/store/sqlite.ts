import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import { config } from "../../config.js";
import type { Artifact, Project, ProjectListQuery, ProjectPage, Source } from "../types.js";
import {
  JsonProjectStore,
  normalizeProject,
  pageProjects,
  type ApiKeyMetadata,
  type ApiKeyStore,
  type ProjectStore,
  type StoredApiKeyRecord,
} from "../store.js";

interface ApiKeyRow {
  id: string;
  key_hash: string;
  prefix: string;
  client_id: string;
  subject: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function apiKeyMetadata(row: ApiKeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    prefix: row.prefix,
    clientId: row.client_id,
    subject: row.subject,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function storedApiKeyRecord(row: ApiKeyRow): StoredApiKeyRecord {
  return {
    ...apiKeyMetadata(row),
    keyHash: row.key_hash,
  };
}

export class SqliteProjectStore implements ProjectStore, ApiKeyStore {
  private readonly db: Database.Database;
  private readonly files = new JsonProjectStore();

  constructor(path = join(config.projectDir, "jantra.sqlite")) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      create table if not exists projects (
        client_id text not null,
        project_id text not null,
        updated_at text not null,
        data text not null,
        primary key (client_id, project_id)
      )
    `);
    this.db.exec(`
      create table if not exists api_keys (
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

      create index if not exists idx_api_keys_client_id_created_at
        on api_keys (client_id, created_at desc);

      create index if not exists idx_api_keys_revoked_at
        on api_keys (revoked_at);
    `);
    this.db.exec(`
      create table if not exists client_daily_ideation_spend (
        client_id text not null,
        day_utc text not null,
        usd real not null,
        primary key (client_id, day_utc)
      )
    `);
  }

  saveProject(project: Project): void {
    const normalized = normalizeProject(project);
    this.db
      .prepare(
        `insert into projects (client_id, project_id, updated_at, data)
         values (?, ?, ?, ?)
         on conflict(client_id, project_id)
         do update set updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(
        normalized.clientId,
        normalized.id,
        normalized.updatedAt,
        JSON.stringify(normalized),
      );
  }

  loadProject(clientId: string, projectId: string): Project | null {
    const row = this.db
      .prepare("select data from projects where client_id = ? and project_id = ?")
      .get(clientId, projectId) as { data?: string } | undefined;
    if (!row?.data) return null;
    return normalizeProject(JSON.parse(row.data) as Project);
  }

  listProjects(query: ProjectListQuery): ProjectPage {
    const rows = this.db
      .prepare("select data from projects where client_id = ? order by updated_at desc")
      .all(query.clientId) as { data?: string }[];
    const projects = rows
      .filter((row): row is { data: string } => typeof row.data === "string")
      .map((row) => normalizeProject(JSON.parse(row.data) as Project));
    return pageProjects(projects, query);
  }

  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number {
    const row = this.db
      .prepare(
        "select usd from client_daily_ideation_spend where client_id = ? and day_utc = ?",
      )
      .get(clientId, dayUtc) as { usd?: number } | undefined;
    return row?.usd ?? 0;
  }

  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    this.db
      .prepare(
        `insert into client_daily_ideation_spend (client_id, day_utc, usd)
         values (?, ?, ?)
         on conflict(client_id, day_utc)
         do update set usd = usd + excluded.usd`,
      )
      .run(clientId, dayUtc, deltaUsd);
  }

  writeArtifactFile(clientId: string, projectId: string, artifact: Artifact): string {
    return this.files.writeArtifactFile(clientId, projectId, artifact);
  }

  writeSourceContentFile(
    clientId: string,
    projectId: string,
    source: Source,
    content: string,
  ): string {
    return this.files.writeSourceContentFile(clientId, projectId, source, content);
  }

  createApiKey(record: StoredApiKeyRecord): ApiKeyMetadata {
    this.db
      .prepare(
        `insert into api_keys (
          id, key_hash, prefix, client_id, subject, label, created_at, last_used_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.keyHash,
        record.prefix,
        record.clientId,
        record.subject,
        record.label,
        record.createdAt,
        record.lastUsedAt,
        record.revokedAt,
      );
    return {
      id: record.id,
      prefix: record.prefix,
      clientId: record.clientId,
      subject: record.subject,
      label: record.label,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      revokedAt: record.revokedAt,
    };
  }

  getApiKeyByHash(keyHash: string): StoredApiKeyRecord | null {
    const row = this.db
      .prepare("select * from api_keys where key_hash = ?")
      .get(keyHash) as ApiKeyRow | undefined;
    return row ? storedApiKeyRecord(row) : null;
  }

  listApiKeys(query: { clientId?: string; includeRevoked?: boolean }): ApiKeyMetadata[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (query.clientId) {
      clauses.push("client_id = ?");
      args.push(query.clientId);
    }
    if (!query.includeRevoked) {
      clauses.push("revoked_at is null");
    }
    const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from api_keys${where} order by created_at desc`)
      .all(...args) as ApiKeyRow[];
    return rows.map(apiKeyMetadata);
  }

  revokeApiKey(id: string, revokedAt: string): ApiKeyMetadata | null {
    this.db
      .prepare("update api_keys set revoked_at = ? where id = ? and revoked_at is null")
      .run(revokedAt, id);
    const row = this.db
      .prepare("select * from api_keys where id = ?")
      .get(id) as ApiKeyRow | undefined;
    return row ? apiKeyMetadata(row) : null;
  }

  touchApiKeyLastUsed(id: string, usedAt: string): void {
    this.db.prepare("update api_keys set last_used_at = ? where id = ?").run(usedAt, id);
  }

  close(): void {
    this.db.close();
  }
}

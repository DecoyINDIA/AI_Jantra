import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import { config } from "../../config.js";
import type {
  Artifact,
  Project,
  ProjectListQuery,
  ProjectPage,
  ProjectSummary,
  Source,
  StageStatus,
} from "../types.js";
import {
  decodeCursor,
  encodeCursor,
  JsonProjectStore,
  normalizeProject,
  type ApiKeyMetadata,
  type ApiKeyStore,
  type ProjectStore,
  type StoredApiKeyRecord,
} from "../store.js";
import { runMigrations } from "./migrations/index.js";
import { importLegacyJsonData } from "./migrations/importLegacyJson.js";
import {
  SqliteLeadStore,
  type LeadRecord,
  type LeadStore,
} from "../../server/leads/store.js";
import {
  SqliteWebhookSubscriptionStore,
  type WebhookSubscriptionStore,
} from "../../server/webhooks/store.js";
import type { WebhookSubscription } from "../../server/webhooks/types.js";
import type { JobKind, JobRecord, JobStatus, JobStore } from "../../server/jobs/types.js";

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
  scope?: string | null;
  allowed_agents?: string | null;
}

function apiKeyMetadata(row: ApiKeyRow): ApiKeyMetadata {
  let allowedAgents: string[] | null = null;
  if (row.allowed_agents) {
    try {
      const parsed = JSON.parse(row.allowed_agents);
      if (Array.isArray(parsed)) allowedAgents = parsed;
    } catch {}
  }
  return {
    id: row.id,
    prefix: row.prefix,
    clientId: row.client_id,
    subject: row.subject,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    scope: (row.scope as "full" | "public") ?? "full",
    allowedAgents,
  };
}

function storedApiKeyRecord(row: ApiKeyRow): StoredApiKeyRecord {
  return {
    ...apiKeyMetadata(row),
    keyHash: row.key_hash,
  };
}

interface JobRow {
  id: string;
  client_id: string;
  run_id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toJobRecord(row: JobRow): JobRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {}
  return {
    id: row.id,
    clientId: row.client_id,
    runId: row.run_id,
    kind: row.kind as JobKind,
    payload,
    status: row.status as JobStatus,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface SqliteStoreOptions {
  leadDir?: string;
  projectDir?: string;
  skipImport?: boolean;
}

export class SqliteProjectStore
  implements ProjectStore, ApiKeyStore, LeadStore, WebhookSubscriptionStore, JobStore
{
  private readonly db: Database.Database;
  private readonly files = new JsonProjectStore();
  private readonly leadStore: SqliteLeadStore;
  private readonly webhookStore: SqliteWebhookSubscriptionStore;

  constructor(
    path = join(config.projectDir, "jantra.sqlite"),
    options?: SqliteStoreOptions,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    runMigrations(this.db);
    if (!options?.skipImport) {
      importLegacyJsonData(this.db, {
        leadDir: options?.leadDir,
        projectDir: options?.projectDir ?? dirname(path),
      });
    }
    this.leadStore = new SqliteLeadStore(this.db);
    this.webhookStore = new SqliteWebhookSubscriptionStore(this.db);
  }

  saveProject(project: Project): void {
    const normalized = normalizeProject(project);
    const currentStage = normalized.stages[normalized.currentStage];
    this.db
      .prepare(
        `insert into projects (
          client_id, project_id, updated_at, title, agent_id, agent_version,
          status, current_stage, current_stage_status, cost_usd, created_at, data
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(client_id, project_id)
        do update set
          updated_at = excluded.updated_at,
          title = excluded.title,
          agent_id = excluded.agent_id,
          agent_version = excluded.agent_version,
          status = excluded.status,
          current_stage = excluded.current_stage,
          current_stage_status = excluded.current_stage_status,
          cost_usd = excluded.cost_usd,
          created_at = excluded.created_at,
          data = excluded.data`,
      )
      .run(
        normalized.clientId,
        normalized.id,
        normalized.updatedAt,
        normalized.title,
        normalized.agentId,
        normalized.agentVersion,
        normalized.status,
        normalized.currentStage,
        currentStage?.status ?? "pending",
        normalized.cost.usd,
        normalized.createdAt ?? normalized.updatedAt,
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
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const cursor = decodeCursor(query.cursor);

    const whereClauses: string[] = ["client_id = ?"];
    const params: unknown[] = [query.clientId];

    if (query.agentId) {
      whereClauses.push("agent_id = ?");
      params.push(query.agentId);
    }
    if (query.status) {
      whereClauses.push("status = ?");
      params.push(query.status);
    }
    if (query.currentStage) {
      whereClauses.push("current_stage = ?");
      params.push(query.currentStage);
    }
    if (cursor) {
      whereClauses.push("(updated_at < ? or (updated_at = ? and project_id < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const sql = `
      select project_id, client_id, updated_at, title, agent_id, agent_version,
             status, current_stage, current_stage_status, cost_usd, created_at
      from projects
      where ${whereClauses.join(" and ")}
      order by updated_at desc, project_id desc
      limit ?
    `;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      project_id: string;
      client_id: string;
      updated_at: string;
      title: string | null;
      agent_id: string | null;
      agent_version: number | null;
      status: string | null;
      current_stage: string | null;
      current_stage_status: string | null;
      cost_usd: number | null;
      created_at: string | null;
    }>;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: ProjectSummary[] = pageRows.map((r) => ({
      id: r.project_id,
      title: r.title ?? "Untitled",
      clientId: r.client_id,
      agentId: r.agent_id ?? "unknown",
      agentVersion: r.agent_version ?? 1,
      status: (r.status as "active" | "completed" | "abandoned") ?? "active",
      currentStage: r.current_stage ?? "intake",
      currentStageStatus: (r.current_stage_status as StageStatus) ?? "pending",
      costUsd: r.cost_usd ?? 0,
      createdAt: r.created_at ?? r.updated_at,
      updatedAt: r.updated_at,
    }));

    return {
      items,
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!) : undefined,
    };
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

  getClientDailyGatewaySpend(clientId: string, dayUtc: string): number {
    const row = this.db
      .prepare(
        "select usd from client_daily_gateway_spend where client_id = ? and day_utc = ?",
      )
      .get(clientId, dayUtc) as { usd?: number } | undefined;
    return row?.usd ?? 0;
  }

  addClientDailyGatewaySpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    this.db
      .prepare(
        `insert into client_daily_gateway_spend (client_id, day_utc, usd)
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
    const scope = record.scope ?? "full";
    const allowedAgentsJson = record.allowedAgents ? JSON.stringify(record.allowedAgents) : null;
    this.db
      .prepare(
        `insert into api_keys (
          id, key_hash, prefix, client_id, subject, label, created_at, last_used_at, revoked_at,
          scope, allowed_agents
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        scope,
        allowedAgentsJson,
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
      scope,
      allowedAgents: record.allowedAgents ?? null,
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

  // LeadStore delegation
  createLead(record: LeadRecord): LeadRecord {
    return this.leadStore.createLead(record);
  }

  listLeads(clientId: string): LeadRecord[] {
    return this.leadStore.listLeads(clientId);
  }

  listLeadsByUser(clientId: string, userSub: string): LeadRecord[] {
    return this.leadStore.listLeadsByUser(clientId, userSub);
  }

  deleteLead(clientId: string, id: string): boolean {
    return this.leadStore.deleteLead ? this.leadStore.deleteLead(clientId, id) : false;
  }

  getLeadStore(): LeadStore {
    return this.leadStore;
  }

  // WebhookSubscriptionStore delegation
  list(clientId: string): WebhookSubscription[] {
    return this.webhookStore.list(clientId);
  }

  create(subscription: WebhookSubscription): WebhookSubscription {
    return this.webhookStore.create(subscription);
  }

  delete(clientId: string, id: string): boolean {
    return this.webhookStore.delete(clientId, id);
  }

  getWebhookStore(): WebhookSubscriptionStore {
    return this.webhookStore;
  }

  // JobStore implementation
  createJob(job: JobRecord): JobRecord {
    this.db
      .prepare(
        `insert into jobs (
          id, client_id, run_id, kind, payload, status, attempts, error, created_at, started_at, finished_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.clientId,
        job.runId,
        job.kind,
        JSON.stringify(job.payload ?? {}),
        job.status,
        job.attempts,
        job.error ?? null,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
      );
    return job;
  }

  getJob(clientId: string, runId: string, jobId: string): JobRecord | null {
    const row = this.db
      .prepare("select * from jobs where client_id = ? and run_id = ? and id = ?")
      .get(clientId, runId, jobId) as JobRow | undefined;
    return row ? toJobRecord(row) : null;
  }

  claimNextJob(): JobRecord | null {
    const now = new Date().toISOString();
    const claimTx = this.db.transaction(() => {
      const row = this.db
        .prepare("select * from jobs where status = 'queued' order by created_at asc limit 1")
        .get() as JobRow | undefined;
      if (!row) return null;
      this.db
        .prepare(
          "update jobs set status = 'running', started_at = ?, attempts = attempts + 1 where id = ? and status = 'queued'",
        )
        .run(now, row.id);
      return {
        ...toJobRecord(row),
        status: "running" as const,
        startedAt: now,
        attempts: row.attempts + 1,
      };
    });
    return claimTx();
  }

  finishJob(jobId: string, error?: string | null): void {
    const now = new Date().toISOString();
    if (error) {
      this.db
        .prepare("update jobs set status = 'failed', error = ?, finished_at = ? where id = ?")
        .run(error, now, jobId);
    } else {
      this.db
        .prepare("update jobs set status = 'done', finished_at = ? where id = ?")
        .run(now, jobId);
    }
  }

  requeueRunningJobs(): number {
    const result = this.db
      .prepare("update jobs set status = 'queued' where status = 'running'")
      .run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

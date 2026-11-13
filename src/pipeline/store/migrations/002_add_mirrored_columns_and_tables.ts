import type Database from "better-sqlite3";
import type { Project } from "../../types.js";

function addColumnIfNotExists(
  db: Database.Database,
  table: string,
  columnDef: string,
  columnName: string,
): void {
  const tableInfo = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  const hasColumn = tableInfo.some((col) => col.name.toLowerCase() === columnName.toLowerCase());
  if (!hasColumn) {
    db.exec(`alter table ${table} add column ${columnDef}`);
  }
}

export function up(db: Database.Database): void {
  // 1. Api keys scope and allowed_agents
  addColumnIfNotExists(db, "api_keys", "scope text not null default 'full'", "scope");
  addColumnIfNotExists(db, "api_keys", "allowed_agents text", "allowed_agents");

  // 2. Leads table
  db.exec(`
    create table if not exists leads (
      id text primary key,
      client_id text not null,
      user_sub text,
      name text not null,
      email text not null,
      phone text,
      idea text not null,
      source text not null,
      run_id text,
      created_at text not null,
      deleted_at text
    );

    create index if not exists idx_leads_client_created
      on leads (client_id, created_at desc);
  `);

  // 3. Webhook subscriptions table
  db.exec(`
    create table if not exists webhook_subscriptions (
      id text primary key,
      client_id text not null,
      url text not null,
      secret text,
      events text not null,
      created_at text not null
    );

    create index if not exists idx_webhook_subscriptions_client
      on webhook_subscriptions (client_id);
  `);

  // 4. Jobs table (ready for T-014)
  db.exec(`
    create table if not exists jobs (
      id text primary key,
      client_id text not null,
      run_id text not null,
      kind text not null,
      payload text not null,
      status text not null,
      attempts integer not null default 0,
      error text,
      created_at text not null,
      started_at text,
      finished_at text
    );

    create index if not exists idx_jobs_status_created
      on jobs (status, created_at);
  `);

  // 5. Mirrored columns on projects
  addColumnIfNotExists(db, "projects", "title text", "title");
  addColumnIfNotExists(db, "projects", "agent_id text", "agent_id");
  addColumnIfNotExists(db, "projects", "agent_version integer", "agent_version");
  addColumnIfNotExists(db, "projects", "status text", "status");
  addColumnIfNotExists(db, "projects", "current_stage text", "current_stage");
  addColumnIfNotExists(db, "projects", "current_stage_status text", "current_stage_status");
  addColumnIfNotExists(db, "projects", "cost_usd real", "cost_usd");
  addColumnIfNotExists(db, "projects", "created_at text", "created_at");

  db.exec(`
    create index if not exists idx_projects_client_updated
      on projects (client_id, updated_at desc);
  `);

  // 6. Backfill existing projects with data
  const rows = db
    .prepare("select client_id, project_id, data from projects where agent_id is null and data is not null")
    .all() as Array<{ client_id: string; project_id: string; data: string }>;

  const updateStmt = db.prepare(`
    update projects set
      title = ?,
      agent_id = ?,
      agent_version = ?,
      status = ?,
      current_stage = ?,
      current_stage_status = ?,
      cost_usd = ?,
      created_at = ?
    where client_id = ? and project_id = ?
  `);

  for (const row of rows) {
    try {
      const project = JSON.parse(row.data) as Project;
      const currentStage = project.stages?.[project.currentStage];
      updateStmt.run(
        project.title ?? "Untitled",
        project.agentId ?? "unknown",
        project.agentVersion ?? 1,
        project.status ?? "active",
        project.currentStage ?? "intake",
        currentStage?.status ?? "pending",
        project.cost?.usd ?? 0,
        project.createdAt ?? project.updatedAt,
        row.client_id,
        row.project_id,
      );
    } catch {}
  }
}

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import { config } from "../../config.js";
import type { Artifact, Project, ProjectListQuery, ProjectPage, Source } from "../types.js";
import {
  JsonProjectStore,
  normalizeProject,
  pageProjects,
  type ProjectStore,
} from "../store.js";

export class SqliteProjectStore implements ProjectStore {
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

  close(): void {
    this.db.close();
  }
}

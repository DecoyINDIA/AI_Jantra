import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { config } from "../config.js";
import { planningPipelineDefinition } from "../agents/planningPipeline.js";
import { snapshotDefinition } from "../agents/definition.js";
import { emptyCostRollup } from "../runtime/telemetry.js";
import type {
  Artifact,
  CostRollup,
  Project,
  ProjectListQuery,
  ProjectPage,
  ProjectSummary,
  Source,
} from "./types.js";
import { scoreSource } from "./research/sourceQuality.js";

// SQLite migration work lives under ./store/ while this file keeps the shared store contract.
export interface ProjectStore {
  saveProject(project: Project): void;
  loadProject(clientId: string, projectId: string): Project | null;
  listProjects(query: ProjectListQuery): ProjectPage;
  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number;
  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void;
  writeArtifactFile(clientId: string, projectId: string, artifact: Artifact): string;
  writeSourceContentFile(
    clientId: string,
    projectId: string,
    source: Source,
    content: string,
  ): string;
}

export interface ApiKeyMetadata {
  id: string;
  prefix: string;
  clientId: string;
  subject: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface StoredApiKeyRecord extends ApiKeyMetadata {
  keyHash: string;
}

export interface ApiKeyStore {
  createApiKey(record: StoredApiKeyRecord): ApiKeyMetadata;
  getApiKeyByHash(keyHash: string): StoredApiKeyRecord | null;
  listApiKeys(query: { clientId?: string; includeRevoked?: boolean }): ApiKeyMetadata[];
  revokeApiKey(id: string, revokedAt: string): ApiKeyMetadata | null;
  touchApiKeyLastUsed(id: string, usedAt: string): void;
}

function clientDir(clientId: string): string {
  return join(config.projectDir, clientId);
}

function projectFile(clientId: string, projectId: string): string {
  return join(clientDir(clientId), `${projectId}.json`);
}

function spendFile(clientId: string): string {
  return join(clientDir(clientId), "spend.json");
}

function projectDir(clientId: string, projectId: string): string {
  return join(clientDir(clientId), projectId);
}

function artifactDir(clientId: string, projectId: string): string {
  return projectDir(clientId, projectId);
}

function sourceDir(clientId: string, projectId: string): string {
  return join(projectDir(clientId, projectId), "sources");
}

const LEGACY_PLANNING_SNAPSHOT = snapshotDefinition(planningPipelineDefinition);

function ensureCost(
  cost: Partial<CostRollup> | undefined,
  stageIds: string[],
): CostRollup {
  const empty = emptyCostRollup(stageIds);
  return {
    ...empty,
    ...cost,
    perStage: {
      ...empty.perStage,
      ...(cost?.perStage ?? {}),
    },
  };
}

export function normalizeProject(project: Project): Project {
  project.agentId ??= LEGACY_PLANNING_SNAPSHOT.id;
  project.agentVersion ??= LEGACY_PLANNING_SNAPSHOT.version;
  project.agentDefinitionSnapshot ??= LEGACY_PLANNING_SNAPSHOT;
  for (const stage of Object.values(project.stages)) {
    stage.evals ??= [];
  }
  project.sources ??= [];
  for (const source of project.sources) {
    source.qualityScore ??= scoreSource(source);
  }
  project.claims ??= [];
  project.interactions ??= [];
  project.execution ??= {};
  project.cost = ensureCost(
    project.cost,
    project.agentDefinitionSnapshot.stageOrder.length
      ? project.agentDefinitionSnapshot.stageOrder
      : Object.keys(project.stages),
  );
  return project;
}

function readSpend(clientId: string): Record<string, number> {
  const file = spendFile(clientId);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function encodeCursor(project: ProjectSummary): string {
  return Buffer.from(`${project.updatedAt}\n${project.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("\n");
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function projectSummary(project: Project): ProjectSummary {
  const currentStage = project.stages[project.currentStage];
  return {
    id: project.id,
    title: project.title,
    clientId: project.clientId,
    agentId: project.agentId,
    agentVersion: project.agentVersion,
    status: project.status,
    currentStage: project.currentStage,
    currentStageStatus: currentStage?.status ?? "pending",
    costUsd: project.cost.usd,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function pageProjects(projects: Project[], query: ProjectListQuery): ProjectPage {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const cursor = decodeCursor(query.cursor);
  const filtered = projects
    .filter((project) => project.clientId === query.clientId)
    .filter((project) => !query.agentId || project.agentId === query.agentId)
    .filter((project) => !query.status || project.status === query.status)
    .filter((project) => !query.currentStage || project.currentStage === query.currentStage)
    .sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      return byUpdated || b.id.localeCompare(a.id);
    });
  const start = cursor
    ? filtered.findIndex(
        (project) => project.updatedAt === cursor.updatedAt && project.id === cursor.id,
      ) + 1
    : 0;
  const page = filtered.slice(Math.max(start, 0), Math.max(start, 0) + limit);
  const items = page.map(projectSummary);
  const hasMore = Math.max(start, 0) + limit < filtered.length;
  return {
    items,
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!) : undefined,
  };
}

export class JsonProjectStore implements ProjectStore {
  saveProject(project: Project): void {
    mkdirSync(clientDir(project.clientId), { recursive: true });
    writeFileSync(
      projectFile(project.clientId, project.id),
      JSON.stringify(normalizeProject(project), null, 2),
      "utf8",
    );
  }

  loadProject(clientId: string, projectId: string): Project | null {
    const file = projectFile(clientId, projectId);
    if (!existsSync(file)) return null;
    return normalizeProject(JSON.parse(readFileSync(file, "utf8")) as Project);
  }

  listProjects(query: ProjectListQuery): ProjectPage {
    const dir = clientDir(query.clientId);
    if (!existsSync(dir)) return { items: [] };
    const projects = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "spend.json")
      .map((f) => normalizeProject(JSON.parse(readFileSync(join(dir, f), "utf8")) as Project));
    return pageProjects(projects, query);
  }

  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number {
    return readSpend(clientId)[dayUtc] ?? 0;
  }

  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    mkdirSync(clientDir(clientId), { recursive: true });
    // JSON storage is single-process today; read-modify-write is acceptable until
    // the public service moves fully to a transactional database.
    const spend = readSpend(clientId);
    spend[dayUtc] = (spend[dayUtc] ?? 0) + deltaUsd;
    writeFileSync(spendFile(clientId), JSON.stringify(spend, null, 2), "utf8");
  }

  writeArtifactFile(clientId: string, projectId: string, artifact: Artifact): string {
    const dir = artifactDir(clientId, projectId);
    mkdirSync(dir, { recursive: true });
    const name = `${artifact.stage}-${artifact.kind}-v${artifact.version}.md`;
    const path = join(dir, name);
    writeFileSync(path, artifact.content, "utf8");
    return path;
  }

  writeSourceContentFile(
    clientId: string,
    projectId: string,
    source: Source,
    content: string,
  ): string {
    const dir = sourceDir(clientId, projectId);
    mkdirSync(dir, { recursive: true });
    const safeId = source.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(dir, `${safeId}.txt`);
    writeFileSync(path, content, "utf8");
    return path;
  }
}

export const defaultStore: ProjectStore = new JsonProjectStore();

export function saveProject(project: Project): void {
  defaultStore.saveProject(project);
}

export function loadProject(clientId: string, projectId: string): Project | null {
  return defaultStore.loadProject(clientId, projectId);
}

export function listProjects(query: ProjectListQuery): ProjectPage {
  return defaultStore.listProjects(query);
}

export function getClientDailyIdeationSpend(clientId: string, dayUtc: string): number {
  return defaultStore.getClientDailyIdeationSpend(clientId, dayUtc);
}

export function addClientDailyIdeationSpend(
  clientId: string,
  dayUtc: string,
  deltaUsd: number,
): void {
  defaultStore.addClientDailyIdeationSpend(clientId, dayUtc, deltaUsd);
}

export function writeArtifactFile(
  clientId: string,
  projectId: string,
  artifact: Artifact,
): string {
  return defaultStore.writeArtifactFile(clientId, projectId, artifact);
}

export function writeSourceContentFile(
  clientId: string,
  projectId: string,
  source: Source,
  content: string,
): string {
  return defaultStore.writeSourceContentFile(clientId, projectId, source, content);
}

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { config } from "../config.js";
import { planningPipelineDefinition } from "../agents/planningPipeline.js";
import { snapshotDefinition } from "../agents/definition.js";
import { emptyCostRollup } from "../runtime/telemetry.js";
import { encryptSecret, decryptSecret, DecryptionError } from "../security/encryption.js";
import type { SourceBinding } from "./ops/connectors.js";
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

export interface DeliveryConfig {
  channel: "none" | "webhook";
  credentialRef?: "report-webhook";
}

export interface OpsReportingProfile {
  clientId: string;
  businessName: string;
  description?: string;
  currency?: string;
  fiscalCalendar?: string;
  knownEvents?: Array<{
    name: string;
    date: string;
    type: "promo" | "holiday" | "one-off";
    description?: string;
  }>;
  kpiSpec: {
    kpis: Array<{
      id: string;
      name: string;
      formula: string;
      minHistoryPeriods: number;
      target?: number;
      unit?: string;
    }>;
    anomalyConfig?: {
      sensitivity?: "low" | "medium" | "high";
      suppressionList?: string[];
      alertBudget?: number;
    };
  };
  binding: SourceBinding;
  delivery?: DeliveryConfig;
  confirmedAt?: string;
  confirmedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialStore {
  setConnectorCredentials(clientId: string, connector: string, credentials: Record<string, string>): void;
  getConnectorCredentials(clientId: string, connector: string): Record<string, string> | null;
  listConnectorCredentials(clientId: string): string[];
  deleteConnectorCredentials(clientId: string, connector: string): boolean;
}

export interface OpsProfileStore {
  setOpsProfile(profile: OpsReportingProfile): void;
  getOpsProfile(clientId: string): OpsReportingProfile | null;
  deleteOpsProfile(clientId: string): boolean;
}

// SQLite migration work lives under ./store/ while this file keeps the shared store contract.
export interface ProjectStore {
  saveProject(project: Project): void;
  loadProject(clientId: string, projectId: string): Project | null;
  listProjects(query: ProjectListQuery): ProjectPage;
  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number;
  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void;
  getClientDailyGatewaySpend(clientId: string, dayUtc: string): number;
  addClientDailyGatewaySpend(clientId: string, dayUtc: string, deltaUsd: number): void;
  writeArtifactFile(clientId: string, projectId: string, artifact: Artifact): string;
  writeSourceContentFile(
    clientId: string,
    projectId: string,
    source: Source,
    content: string,
  ): string;
  deleteProject?(clientId: string, projectId: string): boolean;
  // Connector credentials
  setConnectorCredentials?(clientId: string, connector: string, credentials: Record<string, string>): void;
  getConnectorCredentials?(clientId: string, connector: string): Record<string, string> | null;
  listConnectorCredentials?(clientId: string): string[];
  deleteConnectorCredentials?(clientId: string, connector: string): boolean;
  // Ops profiles
  setOpsProfile?(profile: OpsReportingProfile): void;
  getOpsProfile?(clientId: string): OpsReportingProfile | null;
  deleteOpsProfile?(clientId: string): boolean;
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
  scope?: "full" | "public";
  allowedAgents?: string[] | null;
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

/**
 * Atomic file write: write to a unique temp file in the same directory, then
 * rename over the target. rename(2) is atomic on the same filesystem, so a
 * crash mid-write leaves either the old file or the new one — never a truncated
 * or partially-written file. (Plain writeFileSync can corrupt a project file if
 * the process dies mid-write.)
 */
function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${atomicSeq++}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

let atomicSeq = 0;

/**
 * Defense-in-depth path guard. clientId/projectId are validated at the request
 * schema layer, but these ids are also turned into filesystem paths here, so we
 * reject anything containing a path separator, whitespace, or a "."/".."
 * segment before it ever reaches join(). A bad value should never get this far;
 * if it does, fail loudly rather than read/write outside the project tree.
 */
export function assertSafePathSegment(value: string, label: string): string {
  if (
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Unsafe ${label} for filesystem path: ${JSON.stringify(value)}`);
  }
  return value;
}

function clientDir(clientId: string): string {
  return join(config.projectDir, assertSafePathSegment(clientId, "clientId"));
}

function projectFile(clientId: string, projectId: string): string {
  return join(clientDir(clientId), `${assertSafePathSegment(projectId, "projectId")}.json`);
}

function namedSpendFile(clientId: string, filename: string): string {
  return join(clientDir(clientId), filename);
}

function projectDir(clientId: string, projectId: string): string {
  return join(clientDir(clientId), assertSafePathSegment(projectId, "projectId"));
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

function readNamedSpend(clientId: string, filename: string): Record<string, number> {
  const file = namedSpendFile(clientId, filename);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function writeNamedSpend(clientId: string, filename: string, spend: Record<string, number>): void {
  atomicWriteFileSync(namedSpendFile(clientId, filename), JSON.stringify(spend, null, 2));
}

export function encodeCursor(project: ProjectSummary): string {
  return Buffer.from(`${project.updatedAt}\n${project.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
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

const NON_PROJECT_FILES = new Set([
  "spend.json",
  "gateway-spend.json",
  "webhooks.json",
  "credentials.json",
  "ops-profile.json",
]);

export class JsonProjectStore implements ProjectStore {
  saveProject(project: Project): void {
    mkdirSync(clientDir(project.clientId), { recursive: true });
    atomicWriteFileSync(
      projectFile(project.clientId, project.id),
      JSON.stringify(normalizeProject(project), null, 2),
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
    const projects: Project[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || NON_PROJECT_FILES.has(f)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (
          raw &&
          typeof raw === "object" &&
          !Array.isArray(raw) &&
          typeof raw.id === "string" &&
          raw.stages &&
          typeof raw.stages === "object" &&
          !Array.isArray(raw.stages)
        ) {
          projects.push(normalizeProject(raw as Project));
        }
      } catch {
        // Skip unparseable or corrupted non-project files
      }
    }
    return pageProjects(projects, query);
  }

  getClientDailyIdeationSpend(clientId: string, dayUtc: string): number {
    return readNamedSpend(clientId, "spend.json")[dayUtc] ?? 0;
  }

  addClientDailyIdeationSpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    mkdirSync(clientDir(clientId), { recursive: true });
    // JSON storage is single-process today; read-modify-write is acceptable until
    // the public service moves fully to a transactional database.
    const spend = readNamedSpend(clientId, "spend.json");
    spend[dayUtc] = Number(((spend[dayUtc] ?? 0) + deltaUsd).toFixed(6));
    writeNamedSpend(clientId, "spend.json", spend);
  }

  getClientDailyGatewaySpend(clientId: string, dayUtc: string): number {
    return readNamedSpend(clientId, "gateway-spend.json")[dayUtc] ?? 0;
  }

  addClientDailyGatewaySpend(clientId: string, dayUtc: string, deltaUsd: number): void {
    mkdirSync(clientDir(clientId), { recursive: true });
    const spend = readNamedSpend(clientId, "gateway-spend.json");
    spend[dayUtc] = Number(((spend[dayUtc] ?? 0) + deltaUsd).toFixed(6));
    writeNamedSpend(clientId, "gateway-spend.json", spend);
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

  deleteProject(clientId: string, projectId: string): boolean {
    const file = projectFile(clientId, projectId);
    const dir = projectDir(clientId, projectId);
    let deleted = false;
    if (existsSync(file)) {
      rmSync(file, { force: true });
      deleted = true;
    }
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      deleted = true;
    }
    return deleted;
  }

  setConnectorCredentials(clientId: string, connector: string, credentials: Record<string, string>): void {
    assertSafePathSegment(clientId, "clientId");
    assertSafePathSegment(connector, "connector");
    const dir = clientDir(clientId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "credentials.json");
    let map: Record<string, string> = {};
    if (existsSync(file)) {
      try {
        map = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
    }
    const encrypted = encryptSecret(JSON.stringify(credentials));
    map[connector] = encrypted;
    atomicWriteFileSync(file, JSON.stringify(map, null, 2));
  }

  getConnectorCredentials(clientId: string, connector: string): Record<string, string> | null {
    assertSafePathSegment(clientId, "clientId");
    assertSafePathSegment(connector, "connector");
    const file = join(clientDir(clientId), "credentials.json");
    if (!existsSync(file)) return null;
    try {
      const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      const encrypted = map[connector];
      if (!encrypted) return null;
      const decrypted = decryptSecret(encrypted);
      return JSON.parse(decrypted) as Record<string, string>;
    } catch (err: any) {
      if (err instanceof DecryptionError) {
        throw err;
      }
      return null;
    }
  }

  listConnectorCredentials(clientId: string): string[] {
    assertSafePathSegment(clientId, "clientId");
    const file = join(clientDir(clientId), "credentials.json");
    if (!existsSync(file)) return [];
    try {
      const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      return Object.keys(map).sort();
    } catch {
      return [];
    }
  }

  deleteConnectorCredentials(clientId: string, connector: string): boolean {
    assertSafePathSegment(clientId, "clientId");
    assertSafePathSegment(connector, "connector");
    const file = join(clientDir(clientId), "credentials.json");
    if (!existsSync(file)) return false;
    try {
      const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      if (!(connector in map)) return false;
      delete map[connector];
      atomicWriteFileSync(file, JSON.stringify(map, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  setOpsProfile(profile: OpsReportingProfile): void {
    assertSafePathSegment(profile.clientId, "clientId");
    const dir = clientDir(profile.clientId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ops-profile.json");
    const sanitizedDelivery: DeliveryConfig = {
      channel: profile.delivery?.channel === "webhook" ? "webhook" : "none",
      ...(profile.delivery?.channel === "webhook"
        ? { credentialRef: profile.delivery.credentialRef ?? "report-webhook" }
        : {}),
    };
    const sanitizedProfile: OpsReportingProfile = {
      ...profile,
      delivery: sanitizedDelivery,
    };
    atomicWriteFileSync(file, JSON.stringify(sanitizedProfile, null, 2));
  }

  getOpsProfile(clientId: string): OpsReportingProfile | null {
    assertSafePathSegment(clientId, "clientId");
    const file = join(clientDir(clientId), "ops-profile.json");
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as any;
      if (raw && raw.delivery) {
        if (raw.delivery.webhookUrl || raw.delivery.webhookSecret) {
          raw.delivery = { channel: "none" };
        } else {
          raw.delivery = {
            channel: raw.delivery.channel === "webhook" ? "webhook" : "none",
            ...(raw.delivery.channel === "webhook"
              ? { credentialRef: raw.delivery.credentialRef ?? "report-webhook" }
              : {}),
          };
        }
      }
      return raw as OpsReportingProfile;
    } catch {
      return null;
    }
  }

  deleteOpsProfile(clientId: string): boolean {
    assertSafePathSegment(clientId, "clientId");
    const file = join(clientDir(clientId), "ops-profile.json");
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

export const defaultStore: ProjectStore = new JsonProjectStore();

export function saveProject(project: Project): void {
  defaultStore.saveProject(project);
}

export function loadProject(clientId: string, projectId: string): Project | null {
  return defaultStore.loadProject(clientId, projectId);
}

export function deleteProject(clientId: string, projectId: string): boolean {
  return defaultStore.deleteProject ? defaultStore.deleteProject(clientId, projectId) : false;
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

export function getClientDailyGatewaySpend(clientId: string, dayUtc: string): number {
  return defaultStore.getClientDailyGatewaySpend(clientId, dayUtc);
}

export function addClientDailyGatewaySpend(
  clientId: string,
  dayUtc: string,
  deltaUsd: number,
): void {
  defaultStore.addClientDailyGatewaySpend(clientId, dayUtc, deltaUsd);
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

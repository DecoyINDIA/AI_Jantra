import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Artifact, Project } from "./types.js";

/**
 * MVP persistence: one JSON file per project under
 * .mainframe/projects/<clientId>/, plus each artifact written as a readable
 * .md so a human can open it directly. A real database replaces this later
 * (runtime requirement R7); the interface here is what stays.
 */
const ROOT = ".mainframe/projects";

function clientDir(clientId: string): string {
  return join(ROOT, clientId);
}

function projectFile(clientId: string, projectId: string): string {
  return join(clientDir(clientId), `${projectId}.json`);
}

function artifactDir(clientId: string, projectId: string): string {
  return join(clientDir(clientId), projectId);
}

export function saveProject(project: Project): void {
  mkdirSync(clientDir(project.clientId), { recursive: true });
  writeFileSync(
    projectFile(project.clientId, project.id),
    JSON.stringify(project, null, 2),
    "utf8",
  );
}

export function loadProject(clientId: string, projectId: string): Project | null {
  const file = projectFile(clientId, projectId);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Project;
}

export function listProjects(clientId: string): Project[] {
  const dir = clientDir(clientId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Project);
}

/** Write an artifact as a readable markdown file next to the project JSON. */
export function writeArtifactFile(
  clientId: string,
  projectId: string,
  artifact: Artifact,
): string {
  const dir = artifactDir(clientId, projectId);
  mkdirSync(dir, { recursive: true });
  const name = `${artifact.stage}-${artifact.kind}-v${artifact.version}.md`;
  const path = join(dir, name);
  writeFileSync(path, artifact.content, "utf8");
  return path;
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

export interface DiagnosticsOptions {
  redact: true;
}

export interface DiagnosticsBundle {
  createdAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  userData: string;
  notes: string[];
}

export async function collectDiagnostics(_options: DiagnosticsOptions): Promise<string> {
  const bundle: DiagnosticsBundle = {
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    versions: process.versions,
    userData: app.getPath("userData"),
    notes: [
      "Prompts, raw artifacts, audit contents, API keys, and model responses are excluded.",
      "Share this file only with Jantra support or an approved operator.",
    ],
  };
  const dir = join(app.getPath("userData"), "diagnostics");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `diagnostics-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(bundle, null, 2), "utf8");
  return path;
}

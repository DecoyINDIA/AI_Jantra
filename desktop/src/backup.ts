import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { desktopAuditDir, desktopProjectDir } from "./paths.js";

export async function createAuditExport(runIdOrClientId: string): Promise<string> {
  const outputDir = join(app.getPath("userData"), "exports");
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, `audit-export-${runIdOrClientId}-${Date.now()}.jsonl`);
  const auditFile = join(desktopAuditDir(), `${runIdOrClientId}.jsonl`);
  if (existsSync(auditFile)) {
    await writeFile(output, await readFile(auditFile, "utf8"), "utf8");
  } else {
    const files = await readdir(desktopAuditDir()).catch(() => []);
    const contents = await Promise.all(
      files.filter((file) => file.endsWith(".jsonl")).map((file) => readFile(join(desktopAuditDir(), file), "utf8")),
    );
    await writeFile(output, contents.join("\n"), "utf8");
  }
  return output;
}

export async function createBackupArchive(): Promise<string> {
  const backupDir = join(app.getPath("userData"), "backups", `backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  if (existsSync(desktopProjectDir())) await cp(desktopProjectDir(), join(backupDir, "projects"), { recursive: true });
  if (existsSync(desktopAuditDir())) await cp(desktopAuditDir(), join(backupDir, "audit"), { recursive: true });
  await writeFile(join(backupDir, "README.txt"), "Jantra local backup. Restore only on a trusted machine.", "utf8");
  return backupDir;
}

export async function restoreBackupArchive(path: string): Promise<void> {
  const projects = join(path, "projects");
  const audit = join(path, "audit");
  if (existsSync(projects)) await cp(projects, desktopProjectDir(), { recursive: true });
  if (existsSync(audit)) await cp(audit, desktopAuditDir(), { recursive: true });
}

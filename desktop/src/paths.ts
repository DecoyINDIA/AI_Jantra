import { app } from "electron";
import { join } from "node:path";

export function desktopProjectDir(): string {
  return join(app.getPath("userData"), "projects");
}

export function desktopAuditDir(): string {
  return join(app.getPath("userData"), "audit");
}

export function desktopDatabasePath(): string {
  return join(app.getPath("userData"), "jantra.sqlite");
}

export function desktopSecretPath(): string {
  return join(app.getPath("userData"), "gemini-key.bin");
}

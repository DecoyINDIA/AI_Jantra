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

export function desktopCredentialsPath(): string {
  return join(app.getPath("userData"), "credentials.bin");
}

export function desktopProviderConfigPath(): string {
  return join(app.getPath("userData"), "provider-config.json");
}

export function desktopLicensePath(): string {
  return join(app.getPath("userData"), "license.json");
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

export interface LicenseStatus {
  active: boolean;
  keySuffix?: string;
  activatedAt?: string;
}

function licensePath(): string {
  return join(app.getPath("userData"), "license.json");
}

export async function activateLicense(key: string): Promise<LicenseStatus> {
  if (!/^JANTRA-[A-Z0-9-]{8,}$/.test(key)) {
    throw new Error("License key format is invalid.");
  }
  const status: LicenseStatus = {
    active: true,
    keySuffix: key.slice(-6),
    activatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(licensePath()), { recursive: true });
  await writeFile(licensePath(), JSON.stringify(status, null, 2), "utf8");
  return status;
}

export async function licenseStatus(): Promise<LicenseStatus> {
  try {
    return JSON.parse(await readFile(licensePath(), "utf8")) as LicenseStatus;
  } catch {
    return { active: false };
  }
}

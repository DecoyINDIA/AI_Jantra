import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

export interface LicenseStore {
  getLicenseToken(): Promise<string | null>;
  saveLicenseToken(token: string): Promise<void>;
  deleteLicenseToken(): Promise<void>;
}

export class FileLicenseStore implements LicenseStore {
  constructor(readonly filePath: string) {}

  async getLicenseToken(): Promise<string | null> {
    try {
      if (!existsSync(this.filePath)) return null;
      const content = await readFile(this.filePath, "utf8");
      const raw = JSON.parse(content) as { token?: string };
      return typeof raw.token === "string" ? raw.token : null;
    } catch {
      return null;
    }
  }

  async saveLicenseToken(token: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const record = {
      token,
      activatedAt: new Date().toISOString(),
    };
    await writeFile(this.filePath, JSON.stringify(record, null, 2), "utf8");
  }

  async deleteLicenseToken(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        await unlink(this.filePath);
      }
    } catch {
      // Ignore deletion errors
    }
  }
}

export class MemoryLicenseStore implements LicenseStore {
  private token: string | null = null;

  constructor(initialToken?: string | null) {
    this.token = initialToken ?? null;
  }

  async getLicenseToken(): Promise<string | null> {
    return this.token;
  }

  async saveLicenseToken(token: string): Promise<void> {
    this.token = token;
  }

  async deleteLicenseToken(): Promise<void> {
    this.token = null;
  }
}

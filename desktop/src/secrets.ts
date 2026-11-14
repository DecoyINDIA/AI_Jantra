import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { desktopCredentialsPath, desktopSecretPath } from "./paths.js";

export interface DesktopCredentials {
  geminiApiKey?: string;
  openAiApiKey?: string;
}

export async function readCredentials(): Promise<DesktopCredentials> {
  try {
    const encrypted = await readFile(desktopCredentialsPath());
    if (!safeStorage.isEncryptionAvailable()) return {};
    const decrypted = safeStorage.decryptString(encrypted);
    return JSON.parse(decrypted) as DesktopCredentials;
  } catch {
    try {
      const encryptedLegacy = await readFile(desktopSecretPath());
      if (safeStorage.isEncryptionAvailable()) {
        const geminiApiKey = safeStorage.decryptString(encryptedLegacy);
        return { geminiApiKey };
      }
    } catch {
      // Legacy key not found
    }
    return {};
  }
}

export async function writeCredentials(creds: DesktopCredentials): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed secret storage is not available.");
  }
  const serialized = JSON.stringify(creds);
  const encrypted = safeStorage.encryptString(serialized);
  await mkdir(dirname(desktopCredentialsPath()), { recursive: true });
  await writeFile(desktopCredentialsPath(), encrypted);

  if (creds.geminiApiKey) {
    await mkdir(dirname(desktopSecretPath()), { recursive: true });
    await writeFile(desktopSecretPath(), safeStorage.encryptString(creds.geminiApiKey));
  }
}

export async function readGeminiKey(): Promise<string | null> {
  const creds = await readCredentials();
  return creds.geminiApiKey ?? null;
}

export async function writeGeminiKey(secret: string): Promise<void> {
  const creds = await readCredentials();
  await writeCredentials({ ...creds, geminiApiKey: secret });
}

export async function readOpenAiKey(): Promise<string | null> {
  const creds = await readCredentials();
  return creds.openAiApiKey ?? null;
}

export async function writeOpenAiKey(secret: string): Promise<void> {
  const creds = await readCredentials();
  await writeCredentials({ ...creds, openAiApiKey: secret });
}

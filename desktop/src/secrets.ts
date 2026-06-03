import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { desktopSecretPath } from "./paths.js";

export async function readGeminiKey(): Promise<string | null> {
  try {
    const encrypted = await readFile(desktopSecretPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
}

export async function writeGeminiKey(secret: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed secret storage is not available.");
  }
  await mkdir(dirname(desktopSecretPath()), { recursive: true });
  await writeFile(desktopSecretPath(), safeStorage.encryptString(secret));
}

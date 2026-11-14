import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { desktopProviderConfigPath } from "./paths.js";

export type DesktopProvider = "gemini" | "openai-compatible";

export interface DesktopProviderConfig {
  provider: DesktopProvider;
  baseUrl?: string;
  modelFlash?: string;
  modelPro?: string;
  dataCollection?: "deny" | "allow";
}

export const DEFAULT_DESKTOP_PROVIDER_CONFIG: DesktopProviderConfig = {
  provider: "gemini",
  baseUrl: "https://openrouter.ai/api/v1",
  modelFlash: "",
  modelPro: "",
};

export async function readProviderConfig(): Promise<DesktopProviderConfig> {
  try {
    const content = await readFile(desktopProviderConfigPath(), "utf8");
    const raw = JSON.parse(content) as Partial<DesktopProviderConfig>;
    return {
      ...DEFAULT_DESKTOP_PROVIDER_CONFIG,
      ...raw,
      provider: raw.provider === "openai-compatible" ? "openai-compatible" : "gemini",
    };
  } catch {
    return { ...DEFAULT_DESKTOP_PROVIDER_CONFIG };
  }
}

export async function writeProviderConfig(
  config: Partial<DesktopProviderConfig>,
): Promise<DesktopProviderConfig> {
  const current = await readProviderConfig();
  const updated: DesktopProviderConfig = {
    ...current,
    ...config,
    provider:
      config.provider === "openai-compatible"
        ? "openai-compatible"
        : config.provider === "gemini"
          ? "gemini"
          : current.provider,
  };
  const path = desktopProviderConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

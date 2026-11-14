export {};

declare global {
  interface Window {
    jantraDesktop?: {
      writeGeminiKey(secret: string): Promise<unknown>;
      writeOpenAiKey(secret: string): Promise<unknown>;
      readProviderConfig(): Promise<unknown>;
      writeProviderConfig(cfg: unknown): Promise<unknown>;
      getCredentialsStatus(): Promise<{ hasGeminiKey: boolean; hasOpenAiKey: boolean }>;
      licenseStatus(): Promise<{
        active: boolean;
        state: string;
        licensee?: string;
        plan?: string;
        expiresAt?: string;
        issuedAt?: string;
        reason?: string;
        unverified?: boolean;
        activatedAt?: string;
      }>;
      activateLicense(key: string): Promise<{
        active: boolean;
        state: string;
        licensee?: string;
        plan?: string;
        expiresAt?: string;
        issuedAt?: string;
        reason?: string;
        unverified?: boolean;
        activatedAt?: string;
      }>;
      collectDiagnostics(): Promise<string>;
      createBackup(): Promise<string>;
      restoreBackup(path: string): Promise<unknown>;
      exportAudit(id: string): Promise<string>;
    };
  }
}

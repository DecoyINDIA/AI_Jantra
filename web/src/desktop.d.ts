export {};

declare global {
  interface Window {
    jantraDesktop?: {
      writeGeminiKey(secret: string): Promise<unknown>;
      licenseStatus(): Promise<{ active: boolean; unverified?: boolean; keySuffix?: string; activatedAt?: string }>;
      activateLicense(key: string): Promise<{ active: boolean; unverified?: boolean; keySuffix?: string; activatedAt?: string }>;
      collectDiagnostics(): Promise<string>;
      createBackup(): Promise<string>;
      restoreBackup(path: string): Promise<unknown>;
      exportAudit(id: string): Promise<string>;
    };
  }
}

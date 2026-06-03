export {};

declare global {
  interface Window {
    jantraDesktop?: {
      writeGeminiKey(secret: string): Promise<unknown>;
      licenseStatus(): Promise<unknown>;
      activateLicense(key: string): Promise<unknown>;
      collectDiagnostics(): Promise<string>;
      createBackup(): Promise<string>;
      restoreBackup(path: string): Promise<unknown>;
      exportAudit(id: string): Promise<string>;
    };
  }
}

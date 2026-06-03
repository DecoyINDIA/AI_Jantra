import { contextBridge, ipcRenderer } from "electron";

function argValue(prefix: string): string {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("JANTRA_DESKTOP", {
  baseUrl: argValue("--jantra-api-base="),
  token: argValue("--jantra-loopback-token="),
  adminToken: argValue("--jantra-admin-token="),
});

contextBridge.exposeInMainWorld("jantraDesktop", {
  writeGeminiKey: (secret: string) => ipcRenderer.invoke("jantra:write-gemini-key", secret),
  licenseStatus: () => ipcRenderer.invoke("jantra:license-status"),
  activateLicense: (key: string) => ipcRenderer.invoke("jantra:activate-license", key),
  collectDiagnostics: () => ipcRenderer.invoke("jantra:collect-diagnostics"),
  createBackup: () => ipcRenderer.invoke("jantra:create-backup"),
  restoreBackup: (path: string) => ipcRenderer.invoke("jantra:restore-backup", path),
  exportAudit: (id: string) => ipcRenderer.invoke("jantra:export-audit", id),
});

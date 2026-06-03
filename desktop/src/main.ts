import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createAuditExport, createBackupArchive, restoreBackupArchive } from "./backup.js";
import { collectDiagnostics } from "./diagnostics.js";
import { activateLicense, licenseStatus } from "./licensing.js";
import { desktopAuditDir, desktopDatabasePath, desktopProjectDir } from "./paths.js";
import { readGeminiKey, writeGeminiKey } from "./secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ApiHandle {
  app: { close: () => Promise<void> };
  baseUrl: string;
  loopbackToken: string;
}

let mainWindow: BrowserWindow | null = null;
let apiHandle: ApiHandle | null = null;

function configureAutoUpdater(): void {
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }
}

async function startApi(): Promise<ApiHandle> {
  process.env.JANTRA_PROJECT_DIR = desktopProjectDir();
  process.env.JANTRA_AUDIT_DIR = desktopAuditDir();
  const key = await readGeminiKey();
  if (key) process.env.GEMINI_API_KEY = key;

  const serverModulePath = "../../dist/server/app.js";
  const sqliteModulePath = "../../dist/pipeline/store/sqlite.js";
  const [{ startLocalApi }, { SqliteProjectStore }] = (await Promise.all([
    import(serverModulePath),
    import(sqliteModulePath),
  ])) as [
    {
      startLocalApi: (options: unknown) => Promise<ApiHandle>;
    },
    {
      SqliteProjectStore: new (path?: string) => unknown;
    },
  ];
  return startLocalApi({
    host: "127.0.0.1",
    port: 0,
    loopbackToken: randomBytes(32).toString("base64url"),
    clientId: "xolver",
    store: new SqliteProjectStore(desktopDatabasePath()),
  });
}

function webEntry(): string {
  const devUrl = process.env.JANTRA_DESKTOP_WEB_URL;
  if (devUrl) return devUrl;
  return join(app.getAppPath(), "web", "dist", "index.html");
}

async function createMainWindow(api: ApiHandle): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Jantra",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--jantra-api-base=${api.baseUrl}`,
        `--jantra-loopback-token=${api.loopbackToken}`,
      ],
    },
  });

  const entry = webEntry();
  if (/^https?:\/\//.test(entry)) {
    await mainWindow.loadURL(entry);
  } else if (existsSync(entry)) {
    await mainWindow.loadFile(entry);
  } else {
    await mainWindow.loadURL("data:text/plain,Jantra web build was not found.");
  }
}

ipcMain.handle("jantra:write-gemini-key", async (_event, secret: string) => {
  await writeGeminiKey(secret);
  return { ok: true };
});
ipcMain.handle("jantra:license-status", () => licenseStatus());
ipcMain.handle("jantra:activate-license", (_event, key: string) => activateLicense(key));
ipcMain.handle("jantra:collect-diagnostics", () => collectDiagnostics({ redact: true }));
ipcMain.handle("jantra:create-backup", () => createBackupArchive());
ipcMain.handle("jantra:restore-backup", (_event, path: string) => restoreBackupArchive(path));
ipcMain.handle("jantra:export-audit", (_event, id: string) => createAuditExport(id));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    await apiHandle?.app.close();
  });

  await app.whenReady();
  apiHandle = await startApi();
  await createMainWindow(apiHandle);
  configureAutoUpdater();
}

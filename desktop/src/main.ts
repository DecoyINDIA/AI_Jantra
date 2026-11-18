import { app, BrowserWindow, session } from "electron";
// electron-updater is CommonJS with lazily defined exports, which Node's ESM
// loader cannot see as named exports; importing { autoUpdater } crashes the
// app at startup. Use the default export.
import electronUpdater from "electron-updater";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createAuditExport, createBackupArchive, restoreBackupArchive } from "./backup.js";
import { collectDiagnostics } from "./diagnostics.js";
import { activateLicense, licenseStatus } from "./licensing.js";
import { desktopAuditDir, desktopDatabasePath, desktopLicensePath, desktopProjectDir } from "./paths.js";
import { readProviderConfig, writeProviderConfig, type DesktopProviderConfig } from "./providerConfig.js";
import { readCredentials, readGeminiKey, writeCredentials, writeGeminiKey, writeOpenAiKey } from "./secrets.js";
import {
  denyAllPermissions,
  installDesktopSecurity,
  registerAppSchemePrivileges,
  serveAppProtocol,
  trustedIpcHandler,
} from "./electronSecurity.js";
import { APP_ENTRY, APP_ORIGIN } from "./windowSecurity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ApiHandle {
  app: { close: () => Promise<void> };
  baseUrl: string;
  loopbackToken: string;
}

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | null = null;
let apiHandle: ApiHandle | null = null;

// Scheme privileges must be registered before the app is ready.
registerAppSchemePrivileges();

/**
 * Compiled runtime (API server + stores), staged into the app as runtime/ by
 * scripts/stage.mjs. Dev and packaged builds use the same layout, so the
 * runtime's imports resolve against the desktop package's node_modules in
 * both (that is where the Electron-compatible better-sqlite3 lives).
 */
function runtimeModule(relative: string): string {
  return `../runtime/${relative}`;
}

/** Built web UI, staged into the app as web/dist. */
function webRoot(): string {
  return join(app.getAppPath(), "web", "dist");
}

function configureAutoUpdater(): void {
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }
}

async function startApi(): Promise<ApiHandle> {
  process.env.JANTRA_PROJECT_DIR = desktopProjectDir();
  process.env.JANTRA_AUDIT_DIR = desktopAuditDir();
  process.env.JANTRA_LICENSE_PATH = desktopLicensePath();

  const providerConfig = await readProviderConfig();
  const credentials = await readCredentials();

  if (credentials.geminiApiKey) {
    process.env.GEMINI_API_KEY = credentials.geminiApiKey;
  }
  if (credentials.openAiApiKey) {
    process.env.JANTRA_API_KEY = credentials.openAiApiKey;
  }

  process.env.JANTRA_PROVIDER = providerConfig.provider;
  if (providerConfig.provider === "openai-compatible") {
    if (providerConfig.baseUrl) {
      process.env.JANTRA_BASE_URL = providerConfig.baseUrl;
    }
    if (providerConfig.modelFlash) {
      process.env.JANTRA_MODEL = providerConfig.modelFlash;
    }
    if (providerConfig.modelPro) {
      process.env.JANTRA_MODEL_PRO = providerConfig.modelPro;
    }
    if (providerConfig.dataCollection) {
      process.env.JANTRA_DATA_COLLECTION = providerConfig.dataCollection;
    }
  }

  const serverModulePath = runtimeModule("server/app.js");
  const sqliteModulePath = runtimeModule("pipeline/store/sqlite.js");
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
    adminToken: process.env.JANTRA_ADMIN_TOKEN,
    // The UI calls the API from app://jantra (or the dev server); allow
    // exactly that origin for CORS. The loopback token is still required.
    allowedOrigins: [APP_ORIGIN, ...devOrigin()],
    licenseEnforcement: true,
    checkCatalogModels: false,
  });
}

function webEntry(): string {
  const devUrl = process.env.JANTRA_DESKTOP_WEB_URL;
  if (devUrl) return devUrl;
  return APP_ENTRY;
}

function devOrigin(): string[] {
  const devUrl = process.env.JANTRA_DESKTOP_WEB_URL;
  if (!devUrl) return [];
  try {
    return [new URL(devUrl).origin];
  } catch {
    return [];
  }
}

async function createMainWindow(api: ApiHandle): Promise<void> {
  const iconPath = join(__dirname, "..", "assets", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Jantra",
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [
        `--jantra-api-base=${api.baseUrl}`,
        `--jantra-loopback-token=${api.loopbackToken}`,
        `--jantra-admin-token=${process.env.JANTRA_ADMIN_TOKEN ?? ""}`,
      ],
    },
  });

  const entry = webEntry();
  if (entry !== APP_ENTRY || existsSync(join(webRoot(), "index.html"))) {
    await mainWindow.loadURL(entry);
  } else {
    await mainWindow.loadURL("data:text/plain,Jantra web build was not found.");
  }
}

installDesktopSecurity({
  getMainWindow: () => mainWindow,
  appEntry: () => webEntry(),
  isolatedPreload: join(__dirname, "isolatedPreload.cjs"),
});
const handleTrusted = trustedIpcHandler({
  getMainWindow: () => mainWindow,
  appEntry: () => webEntry(),
});

handleTrusted("jantra:write-gemini-key", async (_event, secret: string) => {
  await writeGeminiKey(secret);
  return { ok: true };
});
handleTrusted("jantra:write-openai-key", async (_event, secret: string) => {
  await writeOpenAiKey(secret);
  return { ok: true };
});
handleTrusted("jantra:read-provider-config", () => readProviderConfig());
handleTrusted("jantra:write-provider-config", (_event, cfg: unknown) =>
  writeProviderConfig(cfg as Partial<DesktopProviderConfig>),
);
handleTrusted("jantra:get-credentials-status", async () => {
  const creds = await readCredentials();
  return {
    hasGeminiKey: Boolean(creds.geminiApiKey),
    hasOpenAiKey: Boolean(creds.openAiApiKey),
  };
});
handleTrusted("jantra:license-status", () => licenseStatus());
handleTrusted("jantra:activate-license", (_event, key: string) => activateLicense(key));
handleTrusted("jantra:collect-diagnostics", () => collectDiagnostics({ redact: true }));
handleTrusted("jantra:create-backup", () => createBackupArchive());
handleTrusted("jantra:restore-backup", (_event, path: string) => restoreBackupArchive(path));
handleTrusted("jantra:export-audit", (_event, id: string) => createAuditExport(id));

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

  // Not a top-level await: with an ES-module entry, Electron finishes
  // evaluating the main module before it emits "ready", so awaiting
  // whenReady() at top level deadlocks and the app never starts.
  void app
    .whenReady()
    .then(async () => {
      denyAllPermissions(session.defaultSession);
      serveAppProtocol(session.defaultSession, webRoot());
      apiHandle = await startApi();
      await createMainWindow(apiHandle);
      configureAutoUpdater();
    })
    .catch((error: unknown) => {
      // Fail visibly rather than leaving a windowless process running.
      console.error("Jantra failed to start:", error);
      app.exit(1);
    });
}

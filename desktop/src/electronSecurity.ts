import { readFile } from "node:fs/promises";
import { sep } from "node:path";

import { app, ipcMain, protocol, shell, type BrowserWindow, type IpcMainInvokeEvent, type Session } from "electron";

import {
  APP_CSP,
  APP_SCHEME,
  contentTypeFor,
  decideNavigation,
  decideWindowOpen,
  isAppUrl,
  resolveAppAsset,
} from "./windowSecurity.js";

/** Must run before app "ready". Standard + secure gives app:// a real origin. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * Serve the bundled web UI over app://jantra/ from webRoot (inside the asar
 * in packaged builds). Only files under webRoot are reachable; HTML responses
 * carry the console CSP.
 */
export function serveAppProtocol(target: Session, webRoot: string): void {
  target.protocol.handle(APP_SCHEME, async (request) => {
    const file = request.method === "GET" ? resolveAppAsset(request.url, webRoot, sep) : null;
    if (!file) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(file);
      const type = contentTypeFor(file);
      const headers: Record<string, string> = {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      };
      if (type.startsWith("text/html")) headers["content-security-policy"] = APP_CSP;
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

export interface DesktopSecurityOptions {
  getMainWindow: () => BrowserWindow | null;
  /** The UI entry: bundled index.html path or the dev server URL. */
  appEntry: () => string;
  /** Empty preload used for windows showing untrusted documents. */
  isolatedPreload: string;
  /** Injectable for tests; defaults to the system browser. */
  openExternal?: (url: string) => void;
}

/**
 * Locks down every webContents the app creates. Child windows inherit the
 * opener's preload (the desktop bridge with tokens and key-writing IPC), so
 * new windows either open in the system browser or, for the app's own blob
 * report, get an empty preload and a sandbox.
 */
export function installDesktopSecurity(options: DesktopSecurityOptions): void {
  const openExternal =
    options.openExternal ?? ((url: string) => void shell.openExternal(url).catch(() => undefined));

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url);
      if (decision.action === "allow-isolated") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              preload: options.isolatedPreload,
              additionalArguments: [],
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
            },
          },
        };
      }
      if (decision.openExternally) openExternal(decision.openExternally);
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      const main = options.getMainWindow();
      const isMain = main !== null && contents === main.webContents;
      // Main window: only app URLs. Other windows (the isolated report): only
      // their own blob document, which is also how their first load arrives.
      const decision = isMain ? decideNavigation(url, options.appEntry()) : decideWindowOpen(url);
      if (decision.action === "allow-isolated") return;
      // Everything else leaves for the system browser (http/s) or is dropped.
      event.preventDefault();
      if (decision.action === "deny" && decision.openExternally) openExternal(decision.openExternally);
    });

    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** The UI needs no camera, microphone, geolocation, notifications, etc. */
export function denyAllPermissions(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

/** IPC is only for the app's own UI in the main window, never a child or frame. */
export function trustedIpcHandler(options: Pick<DesktopSecurityOptions, "getMainWindow" | "appEntry">) {
  return function handleTrusted<Args extends unknown[], Result>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      const main = options.getMainWindow();
      const fromMain = main !== null && event.sender === main.webContents;
      const frameUrl = event.senderFrame?.url ?? "";
      if (!fromMain || !isAppUrl(frameUrl, options.appEntry())) {
        throw new Error(`Refused ${channel} from an untrusted frame.`);
      }
      return handler(event, ...(args as Args));
    });
  };
}

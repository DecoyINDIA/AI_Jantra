import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent, type Session } from "electron";

import { decideNavigation, decideWindowOpen, isAppUrl } from "./windowSecurity.js";

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

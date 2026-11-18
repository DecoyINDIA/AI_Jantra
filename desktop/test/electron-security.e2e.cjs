// Real-Electron check of the desktop security wiring (desktop/src/electronSecurity.ts).
// Run after `npm run build -w @jantra/desktop`:
//   xvfb-run -a npx electron --no-sandbox desktop/test/electron-security.e2e.cjs
// (--no-sandbox only disables Chromium's OS sandbox, which CI containers lack;
// Electron's per-renderer `sandbox: true` semantics still apply.)
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const dist = path.resolve(__dirname, "..", "dist");
const failures = [];
const check = (label, condition, detail) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${condition ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!condition) failures.push(label);
};
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const { installDesktopSecurity, trustedIpcHandler, denyAllPermissions } = await import(
    pathToFileURL(path.join(dist, "electronSecurity.js")).href
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-e2e-"));
  const entry = path.join(tmp, "index.html");
  fs.writeFileSync(entry, "<!doctype html><title>app</title><p>Jantra UI</p>");

  let mainWindow = null;
  const external = [];
  installDesktopSecurity({
    getMainWindow: () => mainWindow,
    appEntry: () => entry,
    isolatedPreload: path.join(dist, "isolatedPreload.cjs"),
    openExternal: (url) => external.push(url),
  });
  const handleTrusted = trustedIpcHandler({ getMainWindow: () => mainWindow, appEntry: () => entry });
  handleTrusted("jantra:license-status", () => "trusted-ok");
  denyAllPermissions(session.defaultSession);

  const prefs = {
    preload: path.join(dist, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: ["--jantra-loopback-token=SECRET-TOKEN"],
  };
  mainWindow = new BrowserWindow({ show: false, webPreferences: prefs });
  await mainWindow.loadFile(entry);
  const main = mainWindow.webContents;
  const run = (wc, js) => wc.executeJavaScript(js, true);

  check("main window gets the bridge under sandbox", (await run(main, "window.JANTRA_DESKTOP && window.JANTRA_DESKTOP.token")) === "SECRET-TOKEN");
  check("trusted IPC works from the app UI", (await run(main, "window.jantraDesktop.licenseStatus()")) === "trusted-ok");

  const opened = await run(main, "window.open('https://evil.example/x') === null");
  await settle();
  check("https window.open is not opened in-app", opened && BrowserWindow.getAllWindows().length === 1, BrowserWindow.getAllWindows().length);
  check("https window.open goes to the system browser", external.includes("https://evil.example/x"), external);

  const before = external.length;
  await run(main, "window.open('file:///etc/passwd')");
  await settle();
  check("file: window.open refused silently", BrowserWindow.getAllWindows().length === 1 && external.length === before);

  const childPromise = new Promise((resolve) => app.once("browser-window-created", (_e, win) => resolve(win)));
  await run(main, `(() => { const html = '<!doctype html><a id="l" href="https://evil2.example/">x</a>'; const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); window.open(u, '_blank'); return true; })()`);
  const child = await childPromise;
  await new Promise((resolve) => (child.webContents.isLoading() ? child.webContents.once("did-finish-load", resolve) : resolve()));
  const childState = JSON.parse(await run(child.webContents, "JSON.stringify({ desktop: typeof window.JANTRA_DESKTOP, bridge: typeof window.jantraDesktop, url: location.protocol })"));
  check("blob report window opens", childState.url === "blob:", childState);
  check("blob report window has no bridge or tokens", childState.desktop === "undefined" && childState.bridge === "undefined", childState);

  const childUrl = child.webContents.getURL();
  await run(child.webContents, "document.getElementById('l').click()");
  await settle();
  check("links inside the report do not navigate the report window", child.webContents.getURL() === childUrl, child.webContents.getURL());
  check("links inside the report open in the system browser", external.includes("https://evil2.example/"), external);

  // The web console opens the report exactly like this (noopener).
  const noopenerPromise = new Promise((resolve) => app.once("browser-window-created", (_e, win) => resolve(win)));
  await run(main, `(() => { const u = URL.createObjectURL(new Blob(['<title>Report</title><p>r</p>'], { type: 'text/html' })); window.open(u, '_blank', 'noopener'); return true; })()`);
  const noopenerChild = await Promise.race([noopenerPromise, settle(4000).then(() => null)]);
  if (noopenerChild) await settle(800);
  const noopenerState = noopenerChild
    ? JSON.parse(await run(noopenerChild.webContents, "JSON.stringify({ title: document.title, bridge: typeof window.jantraDesktop, opener: window.opener === null })"))
    : null;
  check("report opened with noopener renders, isolated, without opener", Boolean(noopenerState && noopenerState.title === "Report" && noopenerState.bridge === "undefined" && noopenerState.opener), noopenerState);

  const mainUrl = main.getURL();
  await run(main, "location.href = 'https://evil3.example/'; true");
  await settle();
  check("main window cannot be navigated off the app", main.getURL() === mainUrl, main.getURL());
  check("main window navigation attempt goes to the system browser", external.includes("https://evil3.example/"), external);

  // A window that (wrongly) carries the full preload but shows foreign content
  // must still be refused at the IPC layer.
  const rogue = new BrowserWindow({ show: false, webPreferences: prefs });
  await rogue.loadURL("data:text/html,<p>rogue</p>");
  const rogueResult = await run(rogue.webContents, "window.jantraDesktop.licenseStatus().then(() => 'allowed', (e) => 'refused: ' + e.message)");
  check("IPC from an untrusted window is refused", rogueResult.startsWith("refused"), rogueResult);

  const notification = await run(main, "Notification.requestPermission()");
  check("permission requests are denied", notification === "denied", notification);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures.length ? `electron-security: ${failures.length} FAILED` : "electron-security: all checks passed");
  app.exit(failures.length ? 1 : 0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

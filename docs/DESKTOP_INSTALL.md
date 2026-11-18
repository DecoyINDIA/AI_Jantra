# Jantra Desktop Install

1. Run the Jantra Windows installer.
2. Open Jantra from the Start menu.
3. Enter the Gemini API key in Settings.
4. Start the Planning Pipeline or Support Agent from the Agents screen.

Data and audit files are stored under the app user-data folder. The desktop app starts a local API on `127.0.0.1` with a per-launch token.

The user-data folder is named after the product: `%APPDATA%\Jantra` on Windows, `~/Library/Application Support/Jantra` on macOS, `~/.config/Jantra` on Linux.

## Building the desktop app

From the repository root:

```bash
npm ci
npm run build && npm run web:build && npm run build -w @jantra/desktop
npm run dist -w @jantra/desktop                # installer for the current platform
npm run dist -w @jantra/desktop -- --linux dir # unpacked Linux build, used by CI
```

`npm run dist` first runs `scripts/stage.mjs`, which copies the compiled runtime (`dist/`) into `desktop/runtime/` and the web UI (`web/dist/`) into `desktop/web/dist/`. electron-builder only packs files under `desktop/`. Development runs the same staged layout: `npm run dev -w @jantra/desktop`.

The UI is served from `app://jantra/` (not `file://`) with a strict CSP; the local API allows exactly that origin. The desktop package pins better-sqlite3 13.x, a Node-API build whose bundled prebuilds load in Electron without a native rebuild; the server keeps 12.x until it moves to Node 22. Packaged binaries ship with hardened Electron fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`; app code only from the archive).

Acceptance test for a build (runs in CI):

```bash
xvfb-run -a npm run test:packaged -w @jantra/desktop
```

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const desktopDir = join(import.meta.dirname, "..");
/**
 * Deliberate differences from the root runtime's dependencies.
 * better-sqlite3: 12.x does not compile against Electron 42's V8 and has no
 * prebuilds for it; 13.x is Node-API (one binary for Node and Electron) but
 * requires Node >= 22, while the server still supports Node 20. The runtime
 * suites pass on 13.0.3 (verified when this override was introduced).
 */
const DESKTOP_OVERRIDES: Record<string, string> = { "better-sqlite3": "13.0.3" };

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string> };

test("desktop ships every runtime dependency at the root's exact spec", () => {
  // The packaged app runs the repo's compiled runtime from runtime/; its
  // imports resolve against the desktop package's node_modules.
  const root = readJson(join(desktopDir, "..", "package.json")).dependencies ?? {};
  const desktop = readJson(join(desktopDir, "package.json")).dependencies ?? {};
  for (const [name, spec] of Object.entries(root)) {
    if (name in DESKTOP_OVERRIDES) continue;
    assert.equal(desktop[name], spec, `desktop/package.json must declare ${name}@${spec}`);
  }
  for (const [name, spec] of Object.entries(DESKTOP_OVERRIDES)) {
    assert.equal(desktop[name], spec, `desktop/package.json must pin ${name}@${spec}`);
  }
});

test("better-sqlite3 override is Node-API (no per-Electron rebuild needed)", () => {
  const pkg = JSON.parse(
    readFileSync(join(desktopDir, "node_modules", "better-sqlite3", "package.json"), "utf8"),
  ) as { version: string; dependencies?: Record<string, string>; scripts?: Record<string, string> };
  assert.equal(pkg.version, DESKTOP_OVERRIDES["better-sqlite3"]);
  assert.ok(pkg.dependencies?.["node-addon-api"], "expected a Node-API build");
  assert.ok(!pkg.scripts?.install, "a Node-API build ships prebuilds and needs no install step");
});

test("electron-builder packs staged runtime and UI, never ../ paths", () => {
  const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
  const files = yml.split("files:")[1]?.split(/\n\S/)[0] ?? "";
  assert.ok(!/-\s*"?\.\.\//.test(files), "files: entries outside the app dir are silently ignored");
  assert.ok(/-\s*runtime\/\*\*/.test(files), "runtime/** must be packed");
  assert.ok(/-\s*web\/dist\/\*\*/.test(files), "web/dist/** must be packed");
  assert.ok(/asarUnpack:[\s\S]*better-sqlite3/.test(yml), "better-sqlite3 must be unpacked from the asar");
  assert.ok(/^npmRebuild:\s*false/m.test(yml), "native rebuild must stay off (Node-API prebuilds)");
  for (const fuse of ["runAsNode: false", "enableNodeOptionsEnvironmentVariable: false", "enableNodeCliInspectArguments: false", "onlyLoadAppFromAsar: true"]) {
    assert.ok(yml.includes(fuse), `electronFuses must set ${fuse}`);
  }
});

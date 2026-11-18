import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const desktopDir = join(import.meta.dirname, "..");
/**
 * Deliberate differences from the root runtime's dependencies. Empty since the
 * server moved to Node 22 and better-sqlite3 13 (Node-API), which loads in
 * both Node and Electron; keep it that way unless a dependency truly cannot be
 * shared.
 */
const DESKTOP_OVERRIDES: Record<string, string> = {};

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

test("better-sqlite3 is Node-API (one binary for Node and Electron, no Electron rebuild)", () => {
  // Resolve as the desktop package would (hoisted or local).
  const resolved = createRequire(join(desktopDir, "package.json")).resolve("better-sqlite3/package.json");
  const pkg = JSON.parse(readFileSync(resolved, "utf8")) as { version: string; dependencies?: Record<string, string>; scripts?: Record<string, string> };
  const root = readJson(join(desktopDir, "..", "package.json")).dependencies ?? {};
  assert.equal(pkg.version, root["better-sqlite3"]);
  assert.ok(pkg.dependencies?.["node-addon-api"], "expected a Node-API build");
});

test("electron-builder packs staged runtime and UI, never ../ paths", () => {
  const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
  const files = yml.split("files:")[1]?.split(/\n\S/)[0] ?? "";
  assert.ok(!/-\s*"?\.\.\//.test(files), "files: entries outside the app dir are silently ignored");
  assert.ok(/-\s*runtime\/\*\*/.test(files), "runtime/** must be packed");
  assert.ok(/-\s*web\/dist\/\*\*/.test(files), "web/dist/** must be packed");
  assert.ok(/asarUnpack:[\s\S]*better-sqlite3/.test(yml), "better-sqlite3 must be unpacked from the asar");
  assert.ok(/^npmRebuild:\s*false/m.test(yml), "native rebuild must stay off (Node-API prebuilds)");
  for (const fuse of ["runAsNode: false", "enableNodeOptionsEnvironmentVariable: false", "enableNodeCliInspectArguments: false", "onlyLoadAppFromAsar: true", "enableEmbeddedAsarIntegrityValidation: true"]) {
    assert.ok(yml.includes(fuse), `electronFuses must set ${fuse}`);
  }
});

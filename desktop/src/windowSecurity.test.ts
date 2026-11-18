import assert from "node:assert/strict";
import { test } from "node:test";

import { decideNavigation, decideWindowOpen, isAppUrl } from "./windowSecurity.js";

const packagedEntry = "/opt/Jantra/resources/app.asar/web/dist/index.html";
const devEntry = "http://127.0.0.1:5173/";

test("external web links open in the system browser, never in-app", () => {
  for (const url of ["https://evil.example/phish", "http://198.51.100.1/x"]) {
    const decision = decideWindowOpen(url);
    assert.equal(decision.action, "deny");
    assert.equal(decision.action === "deny" && decision.openExternally, new URL(url).toString());
  }
});

test("dangerous schemes are refused outright", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<script>1</script>", "jantra://x", "not a url"]) {
    const decision = decideWindowOpen(url);
    assert.deepEqual(decision, { action: "deny" }, url);
  }
});

test("the app's own blob report may open, isolated", () => {
  assert.equal(decideWindowOpen("blob:file:///6f1c-uuid").action, "allow-isolated");
});

test("app URL matching for packaged and dev builds", () => {
  assert.ok(isAppUrl(`file://${packagedEntry}#/runs/1`, packagedEntry));
  assert.ok(!isAppUrl("file:///etc/passwd", packagedEntry));
  assert.ok(!isAppUrl(`file://${packagedEntry}.evil.html`, packagedEntry));
  assert.ok(isAppUrl("http://127.0.0.1:5173/runs/1", devEntry));
  assert.ok(!isAppUrl("http://127.0.0.1:5174/", devEntry));
  assert.ok(!isAppUrl("https://127.0.0.1:5173/", devEntry));
});

test("main-window navigation stays inside the app", () => {
  assert.equal(decideNavigation(`file://${packagedEntry}`, packagedEntry).action, "allow-isolated");
  const away = decideNavigation("https://evil.example/", packagedEntry);
  assert.equal(away.action, "deny");
  assert.equal(away.action === "deny" && away.openExternally, "https://evil.example/");
  assert.deepEqual(decideNavigation("file:///tmp/x.html", packagedEntry), { action: "deny" });
});

test("app:// assets resolve only inside the web root", async () => {
  const { resolveAppAsset, APP_ENTRY } = await import("./windowSecurity.js");
  const root = "/opt/Jantra/resources/app.asar/web/dist";
  assert.equal(resolveAppAsset(APP_ENTRY, root), `${root}/index.html`);
  assert.equal(resolveAppAsset("app://jantra/", root), `${root}/index.html`);
  assert.equal(resolveAppAsset("app://jantra/assets/index-abc.js?v=1#x", root), `${root}/assets/index-abc.js`);
  // Traversal attempts either normalize to a path inside the root (the URL
  // parser collapses dot segments) or are refused; nothing may escape.
  for (const attempt of [
    "app://jantra/../../etc/passwd",
    "app://jantra/assets/%2e%2e/%2e%2e/secret",
    "app://jantra/..%2f..%2fsecret",
    "app://jantra/assets/..%2F..%2F..%2Fetc%2Fpasswd",
  ]) {
    const resolved = resolveAppAsset(attempt, root);
    assert.ok(
      resolved === null || (resolved.startsWith(`${root}/`) && !resolved.split("/").includes("..")),
      `${attempt} escaped the root: ${resolved}`,
    );
  }
  for (const bad of [
    "app://jantra/a%5c..%5csecret",
    "app://jantra/x%00.js",
    "app://evil/index.html",
    "file:///etc/passwd",
    "http://jantra/index.html",
    "not a url",
  ]) {
    assert.equal(resolveAppAsset(bad, root), null, bad);
  }
});

test("app:// entry counts as the app; lookalikes do not", async () => {
  const { isAppUrl, APP_ENTRY, decideNavigation } = await import("./windowSecurity.js");
  assert.ok(isAppUrl("app://jantra/index.html", APP_ENTRY));
  assert.ok(isAppUrl("app://jantra/", APP_ENTRY));
  assert.ok(!isAppUrl("app://jantra.evil/index.html", APP_ENTRY));
  assert.ok(!isAppUrl("app://evil/index.html", APP_ENTRY));
  assert.ok(!isAppUrl("file:///opt/index.html", APP_ENTRY));
  assert.equal(decideNavigation("app://jantra/index.html", APP_ENTRY).action, "allow-isolated");
  assert.equal(decideNavigation("app://evil/", APP_ENTRY).action, "deny");
});

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

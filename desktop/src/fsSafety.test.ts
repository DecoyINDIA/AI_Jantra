import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertSafeFileId, skipSymlinks } from "./fsSafety.js";

test("file ids reject traversal and separators", () => {
  for (const bad of ["../../etc/passwd", "a/b", "a\\b", "", ".", "..", "x".repeat(129), "run id"]) {
    assert.throws(() => assertSafeFileId(bad), /Invalid/, bad);
  }
  assert.equal(assertSafeFileId("6f1c-2a_b9"), "6f1c-2a_b9");
});

test("backup restore copy drops symlinks but keeps files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jantra-restore-"));
  try {
    const src = join(root, "backup", "projects");
    const dest = join(root, "data", "projects");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "run.json"), "{}");
    await symlink(join(root, "outside-target"), join(src, "evil-link"));
    await cp(src, dest, { recursive: true, filter: skipSymlinks });
    assert.deepEqual((await readdir(dest)).sort(), ["run.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

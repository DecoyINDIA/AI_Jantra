import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { config } from "../../config.js";
import { isRunLocked, markRunDeleted, resetRunLocksForTesting, withRunLock } from "../../pipeline/orchestrator.js";
import { JsonLeadStore, sanitizeErrorMessage } from "./store.js";

it("retention errors never retain arbitrary diagnostic text", () => {
  for (const message of ["Customer Alice Smith: private medical idea", "sk-secret-value", 'password: "hidden"', "C:\\private\\Alice-Smith.txt"]) {
    assert.equal(sanitizeErrorMessage(new Error(message)), "Lead deletion failed closed. Retry after operator review.");
  }
});

it("JSON queue corruption fails closed and preserves exact original bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-review-corruption-"));
  const prior = config.leadDir;
  config.leadDir = dir;
  try {
    const file = path.join(dir, ".deletion_requests.json");
    for (const content of ["", "{broken", "{}", "[{}]", '[{"step":"completed"}]']) {
      fs.writeFileSync(file, content);
      assert.throws(() => new JsonLeadStore(), /queue.*corrupt/i);
      assert.equal(fs.readFileSync(file, "utf8"), content);
    }
  } finally {
    config.leadDir = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("a queued operation rejected by deletion releases its queue reservation", async () => {
  resetRunLocksForTesting();
  const runId = "review-queued-rejected";
  const operation = withRunLock(runId, async () => assert.fail("Deleted operation executed"));
  markRunDeleted(runId);
  await assert.rejects(operation);
  assert.equal(isRunLocked(runId), false);
  resetRunLocksForTesting();
});

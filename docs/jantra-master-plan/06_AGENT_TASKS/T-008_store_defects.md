# TASK ID: T-008

**Title:** Store defects: webhook file in run listing, path safety
**Priority:** P1
**Objective:** Listing runs never chokes on non-project files, and no store builds a filesystem path from an unchecked tenant id.
**Why This Matters:** In JSON-store mode one webhook subscription breaks `GET /v1/runs`; two stores accept `..` as a client id (Audit A-11).
**Prerequisites:** none.
**Effort & Complexity:** Small; low reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-008 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/pipeline/store.ts: function assertSafePathSegment(value, label) (not exported) rejects empty, "/", "\\",
  NUL, "." and "..". JsonProjectStore.listProjects (lines 255-262) reads every file in the client dir that ends
  with ".json" except "spend.json" and "gateway-spend.json", JSON.parses it and calls normalizeProject.
- src/server/webhooks/store.ts stores subscriptions at join(config.projectDir, clientId, "webhooks.json") with
  no segment check. normalizeProject on that array throws (Object.values(undefined)).
- src/server/leads/store.ts builds join(LEAD_DIR or config.leadDir, clientId) and `${leadId}.json`, no check.
- src/server/schemas.ts: clientId pattern for admin key creation is /^[A-Za-z0-9_.:-]+$/ (allows ".." and ":").

FILES TO MODIFY
- src/pipeline/store.ts, src/server/webhooks/store.ts, src/server/leads/store.ts, src/server/schemas.ts,
  src/runtime/evals/regressions.ts

IMPLEMENTATION STEPS
1. store.ts: export assertSafePathSegment (add `export`). In JsonProjectStore.listProjects replace the filter
   and map with a loop that, for each file ending in ".json":
     - skips names in a module constant NON_PROJECT_FILES = new Set(["spend.json", "gateway-spend.json", "webhooks.json"]);
     - parses inside try/catch; skips (does not throw) when parsing fails or when the value is not a plain
       object with a string `id` and an object `stages`;
     - otherwise pushes normalizeProject(value).
2. webhooks/store.ts: import { assertSafePathSegment } from "../../pipeline/store.js" and wrap clientId in
   clientWebhookFile and in the mkdirSync call.
3. leads/store.ts: same import; apply to clientId in clientLeadDir and to leadId in leadFile.
4. schemas.ts: in BOTH createAdminApiKeyBodySchema and listAdminApiKeysQuerySchema change the clientId regex to
   /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/ with message "clientId must start with a letter or digit and use only
   letters, digits, underscore or hyphen.".
5. Regressions:
   - "json-store-ignores-non-project-files": temp dir store; save one project; write webhooks.json ("[]"),
     garbage.json ("{not json"), and other.json ("{\"a\":1}") into the same client dir; listProjects returns
     exactly one item and does not throw. To point JsonProjectStore at a temp dir follow the approach used by
     existing regressions that construct `new JsonProjectStore()` (they rely on config.projectDir set for the
     eval process); write the extra files with path.join(config.projectDir, clientId, ...).
   - "store-path-segments": new JsonWebhookSubscriptionStore().list("..") throws; new JsonLeadStore()
     .listLeadsByUser("..", "u") throws; parseWith(createAdminApiKeyBodySchema, {label:"x", clientId:"..",
     subject:"s"}) throws; clientId "acme-1" parses.

EDGE CASES
- Existing env keys use clientId "xolver" — valid under the new pattern.
- Existing DB keys whose clientId contains "." or ":" keep working for auth (auth does not re-validate); only
  new key creation is stricter. State this under REMAINING in your report.

NON-GOALS: do not encrypt webhook secrets; do not move webhooks to SQLite (T-015).

ACCEPTANCE CRITERIA: npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0;
both regressions pass.

RISK & ROLLBACK: low; revert the commit.

ESCALATION CONDITIONS — stop and report if exporting assertSafePathSegment creates an import cycle that breaks
the typecheck (then duplicate the 10-line function into src/util/pathSafety.ts and import it from all three).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

# TASK ID: T-003

**Title:** Single data root on the persistent disk
**Priority:** P0
**Objective:** Every durable write (projects, audit, leads, ops CSV folder) lands under one configurable root, and the Render blueprint points that root at the mounted disk.
**Why This Matters:** Leads and ops data are written to the container's ephemeral filesystem and vanish on each deploy (Audit A-04).
**Prerequisites:** none. Owner decision D-2 before rollout.
**Effort & Complexity:** Small effort; low reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-003 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- src/config.ts exports `config` with auditDir (env JANTRA_AUDIT_DIR, default ".jantra/audit") and
  projectDir (env JANTRA_PROJECT_DIR, default ".jantra/projects").
- src/server/leads/store.ts line 16: const LEAD_DIR = process.env.JANTRA_LEAD_DIR ?? ".jantra/leads";
- src/pipeline/ops/connectors/csv.ts line 126: const OPS_DATA_ROOT = path.resolve("data", "ops");
  used by the exported resolveClientDataDir(clientId, requested?).
- render.yaml mounts a disk at /data/jantra and sets JANTRA_PROJECT_DIR and JANTRA_AUDIT_DIR only.
- Dockerfile sets WORKDIR /app, so relative paths resolve inside the container image layer.

FILES TO MODIFY
- src/config.ts
- src/server/leads/store.ts
- src/pipeline/ops/connectors/csv.ts
- render.yaml
- .env.example
- README.md (the "Render deployment" section only)
- src/runtime/evals/regressions.ts

IMPLEMENTATION STEPS
1. src/config.ts: above `export const config`, add
     const dataDir = process.env.JANTRA_DATA_DIR ?? ".jantra";
     function dirFromEnv(name: string, sub: string): string {
       return process.env[name] || `${dataDir.replace(/[\\/]+$/, "")}/${sub}`;
     }
   Then in config: add `dataDir,`; change auditDir to dirFromEnv("JANTRA_AUDIT_DIR", "audit");
   projectDir to dirFromEnv("JANTRA_PROJECT_DIR", "projects"); add
   leadDir: dirFromEnv("JANTRA_LEAD_DIR", "leads"), opsDataDir: dirFromEnv("JANTRA_OPS_DATA_DIR", "ops").
   With nothing set, auditDir/projectDir/leadDir resolve to the same values as today.
2. src/server/leads/store.ts: import { config } from "../../config.js"; delete the LEAD_DIR constant and use
   config.leadDir in clientLeadDir.
3. src/pipeline/ops/connectors/csv.ts: import { config } from "../../../config.js"; replace OPS_DATA_ROOT with
   a function opsDataRoot(): string { return path.resolve(config.opsDataDir); } and call it inside
   resolveClientDataDir. Keep the escape check unchanged.
   NOTE the default changes from "data/ops" to ".jantra/ops". In .env.example and README state that existing
   local setups with CSVs under data/ops must set JANTRA_OPS_DATA_DIR=data/ops or move the folder.
4. render.yaml envVars: add
     - key: JANTRA_DATA_DIR         value: /data/jantra
     - key: JANTRA_LEAD_DIR         value: /data/jantra/leads
     - key: JANTRA_OPS_DATA_DIR     value: /data/jantra/ops
     - key: JANTRA_REMOTE_API_KEYS  sync: false
     - key: JANTRA_PUBLIC_SUBJECTS  sync: false
     - key: JANTRA_PUBLIC_AGENT_IDS sync: false
     - key: JANTRA_LOGTO_ISSUER     sync: false
     - key: JANTRA_LOGTO_AUDIENCE   sync: false
     - key: JANTRA_LOGTO_JWKS_URL   sync: false
   Keep the existing JANTRA_PROJECT_DIR and JANTRA_AUDIT_DIR entries.
5. .env.example: replace the three dir comment lines with a JANTRA_DATA_DIR line (default .jantra) and note
   that JANTRA_PROJECT_DIR, JANTRA_AUDIT_DIR, JANTRA_LEAD_DIR, JANTRA_OPS_DATA_DIR override individual folders.
6. README.md Render section: list all four folders under /data/jantra and state that leads are stored there.
7. Regression "data-root-derivation" in regressions.ts. config is evaluated at import, so test the helper:
   export dirFromEnv from config.ts is not possible as written (it closes over dataDir). Instead export a pure
     export function resolveDataDirs(env: Record<string, string | undefined>):
       { dataDir: string; auditDir: string; projectDir: string; leadDir: string; opsDataDir: string }
   implement config's five values by calling resolveDataDirs(process.env), and assert in the regression:
     resolveDataDirs({}) → .jantra, .jantra/audit, .jantra/projects, .jantra/leads, .jantra/ops
     resolveDataDirs({ JANTRA_DATA_DIR: "/data/jantra" }) → all five under /data/jantra
     resolveDataDirs({ JANTRA_DATA_DIR: "/d/", JANTRA_LEAD_DIR: "/x" }) → leadDir "/x", auditDir "/d/audit"
   Also update the existing "csv-directory-resolve" regression only if it hard-codes "data/ops".

EDGE CASES
- Trailing slashes on JANTRA_DATA_DIR must not produce "//".
- Empty-string env values count as unset (use ||, as in step 1).
- Desktop sets JANTRA_PROJECT_DIR and JANTRA_AUDIT_DIR before importing the server; that must keep working.

NON-GOALS
- No data migration code. Do not move leads into SQLite (T-015). Do not touch webhooks or the Dockerfile.

ACCEPTANCE CRITERIA
1. `grep -rn "process.env.JANTRA_LEAD_DIR\|path.resolve(\"data\"" src` returns nothing.
2. npx tsc -p tsconfig.json --noEmit, npm run eval, npm run smoke, npm run server:smoke exit 0.
3. render.yaml parses as YAML and contains the nine new keys.

RISK & ROLLBACK
- Risk: local CSV folder default moved. Documented override. Rollback: revert the commit.
- Operator note (not code): before the first deploy with this change, copy any existing /app/.jantra/leads
  out of the running container if it still exists.

ESCALATION CONDITIONS — stop and report if:
- Another module reads JANTRA_AUDIT_DIR or JANTRA_PROJECT_DIR directly from process.env in a way that would
  diverge from config (smoke tests setting them before import are fine).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

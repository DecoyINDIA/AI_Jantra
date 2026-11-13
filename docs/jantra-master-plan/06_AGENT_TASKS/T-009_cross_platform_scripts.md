# TASK ID: T-009

**Title:** Cross-platform npm scripts; desktop typecheck in CI
**Priority:** P1
**Objective:** Every root npm script runs on macOS, Linux and Windows, and CI typechecks all five packages through the same script developers use.
**Why This Matters:** Root scripts call `npm.cmd`, which exists only on Windows, so `npm run typecheck` fails for most agents and for CI; the desktop package is never typechecked (Audit A-12).
**Prerequisites:** none.
**Effort & Complexity:** Small; trivial reasoning.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-009 in the Jantra AI repository. Read 07_AGENT_CONTEXT.md first.

REPOSITORY CONTEXT
- Root package.json "scripts": typecheck, web:dev, web:build, desktop:dev, desktop:build, client:build,
  embed:build all contain the literal text `npm.cmd run …`.
- .github/workflows/ci.yml job "typecheck" runs `npx tsc -p tsconfig.json --noEmit` and
  `npm run typecheck --workspace=@jantra/<web|client|embed-widget>` — desktop is missing.
- Workspaces: web (@jantra/web), desktop (@jantra/desktop), packages/client (@jantra/client),
  packages/embed-widget (@jantra/embed-widget). Each has its own "typecheck" script except verify this for
  client and embed-widget by opening their package.json.

FILES TO MODIFY: package.json, .github/workflows/ci.yml, AGENTS.md (Commands section only)

IMPLEMENTATION STEPS
1. package.json: replace every occurrence of `npm.cmd` with `npm` in "scripts". Change nothing else.
   (Inside npm scripts, `npm` resolves correctly on Windows as well.)
2. ci.yml job "typecheck": replace the four typecheck steps with one step:
     - name: Typecheck all packages
       run: npm run typecheck
   Keep checkout, setup-node and `npm ci`.
3. AGENTS.md "Commands" list: no wording change needed unless it mentions npm.cmd; if it does, fix it.

EDGE CASES
- `npm ci` on Linux installs the desktop workspace's devDependency `electron`, which downloads a binary. CI
  already runs `npm ci` at the root with workspaces, so this is not new. If the desktop typecheck fails with
  real type errors, DO NOT fix desktop source in this task: report them under REMAINING and escalate a
  separate small fix task. Keep desktop in the root typecheck and keep CI blocking; do not use
  `continue-on-error: true` or omit desktop. Decision D-5 (2026-11-13) makes desktop a product.

NON-GOALS: no dependency changes; no script renames; no changes to web/desktop source.

ACCEPTANCE CRITERIA
1. `grep -n "npm.cmd" package.json` returns nothing.
2. On your platform, `npm run typecheck` runs all five packages and exits 0; desktop failures block CI.
3. `npm run client:build` and `npm run embed:build` start correctly (exit 0).
4. ci.yml is valid YAML.

VERIFICATION
  npm ci
  npm run typecheck
  npm run client:build && npm run embed:build
  npm run eval

RISK & ROLLBACK: CI may go red on pre-existing desktop type errors; escalate a separate fix task and keep
the check blocking. Revert the task changes to roll back.

ESCALATION CONDITIONS — stop and report if a workspace lacks a "typecheck" script (the `--if-present` flag in
the root script should make that harmless; report which one).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

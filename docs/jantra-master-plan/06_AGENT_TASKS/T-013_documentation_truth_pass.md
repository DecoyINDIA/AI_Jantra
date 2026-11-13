# TASK ID: T-013

**Title:** Documentation truth pass
**Priority:** P1
**Objective:** `AGENTS.md`, `README.md`, `.env.example` and `docs/SECURITY_NOTES.md` describe the code as it is; finished kickoff documents are archived so coding agents stop treating them as instructions.
**Why This Matters:** `AGENTS.md` still orders "Gemini 2.5 only", references Windows paths and a second project; an agent obeying it would undo shipped work (Audit A-15). Correct docs are the cheapest way to lower the cost of every later task.
**Prerequisites:** T-009 (so the documented commands are true). Best done after T-001 and T-003 so new variables are included.
**Effort & Complexity:** Small; low reasoning. Documentation only.
**Recommended Agent Tier:** Small agent.

---

## Standalone Execution Prompt

```
You are implementing task T-013 in the Jantra AI repository. Documentation only: do not change any file under
src/, web/, desktop/, packages/ or deploy/. Read 07_AGENT_CONTEXT.md first; it is the source of truth for
structure, conventions and commands. Where a document and the code disagree, the code wins.

FILES TO MODIFY
- AGENTS.md (rewrite)
- README.md (sections "What's here", "Design choices", "Run it", "Status")
- .env.example (regroup only; keep every existing variable)
- docs/SECURITY_NOTES.md (extend)
- docs/archive/ (new folder; move files with `git mv`)
- memory/project-state.md (remove file:///D:/ links only)

IMPLEMENTATION STEPS
1. AGENTS.md — replace the whole file with these sections, in this order, under 120 lines:
   a. One-paragraph description (copy "Project in five lines" from the context package).
   b. "Start here": read docs/ARCHITECTURE.md if present, else this file; then the repository map
      (copy from the context package).
   c. "Hard rules": keep these existing rules verbatim in meaning — all model calls through
      src/model/provider.ts; generator ≠ critic; ground or abstain; untrusted web content; everything
      auditable; fail closed; human gate between stages; secrets never in prompts/logs/artifacts; every record
      carries clientId; Build stage stays disabled.
      REPLACE the "Gemini 2.5 only … no Anthropic/Claude, no OpenAI" rule with: "Providers: Gemini, any
      OpenAI-compatible endpoint, and mock. Stages never import a vendor SDK. Grounded research runs on Gemini."
      ADD: "Never read process.env outside src/config.ts. Never fetch a caller- or model-supplied URL except
      through the shared guarded fetch. Never produce an artifact that states an action happened unless it did."
   d. "Conventions" and "How regressions are written": copy from the context package.
   e. "Commands": npm ci; npm run typecheck; npm run eval; npm run smoke; npm run server:smoke; npm run server;
      npm run pipeline.
   f. "Definition of done": typecheck clean; eval, smoke and server smoke green; a regression added for every
      behaviour change; docs updated if behaviour changed.
   DELETE: the "Multi-project workspace" section, every D:\XOLVER path, the reference to Codex, the
   "Milestone 1 replaces the current Anthropic model calls" sentence, and "add in Milestone 5".
2. README.md — "What's here": extend the tree with model/ (three providers), agents/, server/, web/, desktop/,
   packages/, deploy/. "Design choices": replace "Gemini 2.5 only" with the provider sentence above. "Run it":
   use `npm ci`; keep the rest. "Status": state plainly which agents are production (intake-public), usable
   (planning-pipeline), prototype (ops-onboarding, ops-reporting — reporting does not send reports and needs
   real data), demo (support-agent), and client-specific (firebnb-concierge).
3. .env.example — regroup under comment headers without removing or renaming anything:
   "# 1. LLM provider (the model vendor's key — NOT a Jantra API key)" → JANTRA_PROVIDER, GEMINI_API_KEY,
       JANTRA_BASE_URL, JANTRA_API_KEY, JANTRA_MODEL, JANTRA_MODEL_PRO, JANTRA_PRICE_*, JANTRA_DATA_COLLECTION
   "# 2. Jantra API access (keys that callers present to this server)" → JANTRA_REMOTE_API_KEYS,
       JANTRA_ADMIN_TOKEN, and JANTRA_PUBLIC_SUBJECTS / JANTRA_PUBLIC_AGENT_IDS if present in the file
   "# 3. Server" · "# 4. Storage" · "# 5. Cost ceilings and limits" · "# 6. Identity (Logto)"
   Add one warning line above JANTRA_API_KEY: "# Despite the name, this is the LLM endpoint key."
4. docs/SECURITY_NOTES.md — append short bullets for: public vs full key scope (only if
   src/server/scope.ts exists); rate limiting; webhook URL guard; daily budgets; lead data is personal data
   stored on disk under the data root. Each bullet one sentence, pointing to the source file.
5. Archive: create docs/archive/ and `git mv` into it exactly these finished planning/kickoff documents:
   docs/ANTIGRAVITY_REVIEW_FIX_KICKOFF.md, docs/APP_IMPLEMENTATION_PLAN.md, docs/APP_PLAN.md,
   docs/CODEX_APP_KICKOFF_PROMPT.md, docs/CODEX_EMBED_FOLLOWUP_415.md, docs/CODEX_EMBED_KICKOFF_PROMPT.md,
   docs/CODEX_KEYCONSOLE_KICKOFF.md, docs/CODEX_KEYCONSOLE_REVIEW.md, docs/CODEX_KEYGEN_FOLLOWUP.md,
   docs/CODEX_KICKOFF_PROMPT.md, docs/IMPLEMENTATION_PLAN.md, docs/IMPROVEMENTS_PLAN.md,
   docs/KEYCONSOLE_PLAN.md, docs/MULTI_LLM_PROVIDER_PLAN.md, docs/JANTRA_INTAKE_RESEARCH_REDESIGN_BRIEF.md,
   and root files DYNAMIC_WORKFLOWS_BRIEF.md, RAILWAY_ENV_FIX.md.
   Add docs/archive/README.md: "Historical planning documents. They describe work already done and are not
   instructions." Then fix any links to the moved files in README.md, AGENTS.md, memory/*.md and docs/*.md
   (search for each filename).
   KEEP in place: docs/PRD.md, docs/PIPELINE.md, docs/BUILD_SPEC.md, docs/EMBEDDING_GUIDE.md,
   docs/DESKTOP_INSTALL.md, docs/SECURITY_NOTES.md, docs/agent-factory/, docs/agents/.
6. docs/PRD.md — add ONE note at the top only: "> Status note (<today's date>): sections that say the runtime
   builds on Claude or is Gemini-only are historical; see README for the current provider model." Change
   nothing else in the PRD.
7. memory/project-state.md and memory/handoff-fixes-2026-07-15.md: replace file:///D:/XOLVER/Jantra/ link
   targets with repository-relative paths.

NON-GOALS: no new architecture document (comes later from the planning package); no edits to
.claude/skills/; no code.

ACCEPTANCE CRITERIA
1. `grep -rn "D:\\\\XOLVER\|file:///D:" AGENTS.md README.md memory docs --include=*.md` returns matches only
   inside docs/archive/.
2. `grep -n "Gemini 2.5 only" AGENTS.md README.md` returns nothing.
3. Every command listed in AGENTS.md exists in package.json "scripts".
4. `git status` shows only .md files, .env.example and renames.
5. Every variable present in the old .env.example is still present.

VERIFICATION: run the greps above; run `npm run typecheck` and `npm run eval` to confirm nothing else moved.

RISK & ROLLBACK: none to runtime. Revert the commit.

ESCALATION CONDITIONS — stop and report if .claude/skills/agent-factory/ or docs/agent-factory/ reference a
moved file in a way that changes an agent procedure (report the lines; do not edit those folders).

Finish with the report format from 07_AGENT_CONTEXT.md.
```

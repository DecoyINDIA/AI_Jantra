# Codex kickoff prompt — build and ship the embeddable Jantra intake service

> Paste the block below to Codex as its first instruction. This authorizes Codex to implement directly (not plan-first), building on a verified prototype that already exists in both repos.

---

You are Codex, the coding agent for **Jantra AI**. You are implementing a capability that already has a working, end-to-end-verified **prototype** in the working trees: **Jantra's agent runs as a hosted, embeddable service, and the Xolver website consumes it as its first customer.** Build on that prototype — review it, harden it, finish it, verify it, and ship it live. You may write code directly. Work in small, verifiable steps and keep both repos building at all times.

## You have two folders this time
- `D:\XOLVER\Mainframe` — **Jantra AI** (the service, the agent, the embeddable widget, the edge). This is your home repo.
- `D:\XOLVER\Xolver\Website_Xolver` — **the Xolver website** (the consumer). The Jantra page lives at `templates/jantra` and embeds the widget. This is normally Antigravity's repo; for this function you own both ends so the integration is coherent.

Keep the boundary clean: the agent/service/widget are Jantra's IP in `Mainframe`; the website only **consumes** the service.

## The goal (why this exists)
The agent is Jantra's IP. Do not bolt it onto Xolver. (1) The agent lives inside Jantra as a **hosted service**; (2) the Xolver site **consumes Jantra as a service** (Xolver is customer #1); (3) because it is a proper embeddable service, the same agent later embeds into **any** site or is sold to partners. Architecture, not placement.

## Architecture (as prototyped, verified)
```
Browser (embedding site)
  -> @jantra/embed-widget : mountJantraIntakeWidget(...)   // NO secret in the browser
  -> Cloudflare Worker edge (api.jantra.in)                // holds key, CORS, rate limit, strict path allowlist
  -> private Node origin (startRemoteApi)                  // API-key auth, SQLite on a persistent disk
       public agent "intake-public": runs Intake only, stops at the idea_summary
```
Two facts pin the design: the store is `better-sqlite3` (needs a real filesystem, so the origin is an always-on Node host, **not** a Worker), and the API key is a bearer secret (so the **Worker** holds it; the browser ships no key). It was verified live: the `intake-public` flow runs end to end over HTTP on the mock provider, and the full conversation was driven in a browser (Xolver `templates/jantra` at `localhost:5176` against a local mock server), rendering the idea summary with no console errors.

## Step 1 — Read the binding rules and context, in this order
1. `D:\XOLVER\Mainframe\AGENTS.md` — binding rules for the Jantra repo.
2. `D:\XOLVER\Mainframe\docs\BUILD_SPEC.md`, `docs\PRD.md`, `docs\PIPELINE.md` — runtime, trust layer, Intake stage, human gates.
3. `D:\XOLVER\Mainframe\docs\EMBEDDING_GUIDE.md` and `deploy\cloudflare-worker\README.md` — the embedding + hosting model.
4. `D:\XOLVER\Xolver\Website_Xolver\AGENTS.md` and `JANTRA_PROJECT_BRIEF.md` — website monorepo rules and the Jantra page's design/copy rules (no em dashes; no invented clients/metrics; honesty; build-and-verify discipline).

## Step 2 — The prototype you are building on (read every file before changing it)
**Jantra repo (`D:\XOLVER\Mainframe`):**
- `src/agents/intakePublic.ts` (new) — the `intake-public` agent: single Intake stage, reuses `planning.intake` (`runIntakeReentrant`), stops at the `idea_summary` artifact. Registered in `src/agents/registry.ts`.
- `src/server/remote.ts` (new) + the `server:remote` script in `package.json` — public serve entry via the existing `startRemoteApi` (API-key auth, env `JANTRA_REMOTE_API_KEYS`, host/port).
- `src/server/index.ts` (modified) — added `JANTRA_ALLOWED_ORIGINS` for browser dev testing of the local server.
- `packages/embed-widget/src/index.ts` (modified) — new `mountJantraIntakeWidget`: themeable, dependency-free vanilla DOM that drives createRun -> advance -> answer interactions -> render summary, with `onComplete(summary)`. Built to `dist/`.
- `deploy/cloudflare-worker/` (new) — `worker.js` (key injection, CORS, per-IP rate limit, strict path allowlist), `wrangler.toml`, `README.md`.
- `docs/EMBEDDING_GUIDE.md`, `.env.example` (updated).

**Website repo (`D:\XOLVER\Xolver\Website_Xolver`):**
- `templates/jantra/src/App.tsx` (modified) — replaced the fake multi-select pills + `alert()` in the hero `inquiry-section` with a live `<JantraIntake />`; removed the dead `services`/`toggleService`/`serviceOptions` and unused `Check`/`AnimatePresence` imports.
- `templates/jantra/src/components/JantraIntake.tsx` (new) — React wrapper mounting the widget themed to the page palette (forest `#1C2E1E`, sage `#738273`, Inter).
- `templates/jantra/src/lib/jantraIntakeWidget.ts` (new) — a **vendored copy** of the widget so the static build is self-contained (the Mainframe repo is absent from the website's CI/FTP deploy).
- `templates/jantra/src/lib/jantraConfig.ts` (new) — base URL (`https://api.jantra.in` default), agent id, optional dev key, via `VITE_*`.

## Step 3 — Implement (build on the prototype; do not throw it away)
1. **Confirm it runs as-is.** In `Mainframe`: `npm install`, `npm run build`, `npx tsc -p tsconfig.json --noEmit`, build the widget (`npm run build -w @jantra/embed-widget`). In the website: `npm run build --workspace templates/jantra`. Fix anything broken before adding.
2. **Live Gemini.** Run `intake-public` end to end with a real `GEMINI_API_KEY` (multi-turn intake -> `idea_summary`). Confirm the per-run **cost ceiling** stops a runaway intake and that `JANTRA_MODEL_INTAKE=flash` is the right cost/quality choice for a public page.
3. **Harden the service.** Timeouts/retries and clear error states in the widget; input size limits; rate-limit values on the Worker; audit completeness; confirm secrets never reach prompts, logs, artifacts, or the browser bundle.
4. **Security — shared-tenant isolation (correctness, not optional).** All public traffic shares `clientId=xolver`. The Worker must allowlist only the intake request shapes (create / advance / read-own-run / list-own-interactions / answer) and **block** the tenant-wide `GET /v1/runs` list and the audit routes, so one visitor cannot read another's intake. Verify this.
5. **CORS model.** Confirm remote (`installApiKeyAuth`) mode applies no CORS by design and the **Worker** owns CORS for the browser (origin hop is server-to-server). Ensure no path lets the browser reach the origin directly.
6. **Deploy the service.** Stand up the private Node origin on an always-on host with a **persistent volume** for `.jantra/` (Fly.io / Railway / Render / VPS): `GEMINI_API_KEY`, `JANTRA_REMOTE_API_KEYS=<key>:xolver:web`, `JANTRA_MODEL_INTAKE=flash`, low `JANTRA_COST_CEILING_USD`, project/audit dirs on the volume; run `npm run server:remote`. Deploy the Worker (`deploy/cloudflare-worker/`): set `JANTRA_ORIGIN` and `ALLOWED_ORIGINS` (the real Xolver origins), `wrangler secret put JANTRA_API_KEY`, bind `api.jantra.in`.
7. **Finish + verify the website.** Point the widget at the live edge, build `templates/jantra`, and verify in a browser per the website `AGENTS.md` (live conversation renders where the old pills were; palette/Inter intact; mobile + reduced-motion fine; no console errors; no "Mainframe"/"Yantra"/em-dashes). Then deploy: update `handoff_document.md` + `AGENTS.md` with a phase note, commit, push to `main` (Hostinger).
8. **Widget distribution.** Resolve the vendored-copy duplication: publish `@jantra/embed-widget` (registry) or serve a hosted one-line `<script>`, and keep the website copy in sync until then. For now keep them identical.

## Binding constraints
- **Gemini 2.5 only**, behind the provider interface; **generator != critic**; **ground or abstain**; **everything auditable**; **fail closed**; **human gate**; secrets never in prompts/logs/artifacts/bundles; `clientId` on every record. Stage 4 Build stays disabled.
- The **public agent is intake-only** — never advances into Research or Planning for anonymous web traffic.
- **Website side:** obey `Website_Xolver/AGENTS.md` and the Jantra brief — no em dashes, no invented clients/metrics/testimonials, keep the existing design system / motion / reduced-motion, verify in a browser before done. The captured intake is a real lead and persists server-side in Jantra; do not fabricate a separate contact backend.
- TypeScript strict, ESM, Node >= 20; validate every structured model output with a schema.
- Keep both repos building after every step; commit in small, coherent units with clear messages.

## Productization (design-clean now, build later)
Keep the agent registry and widget theming tenant-clean so these slot in later without rework: per-`clientId` Intake system prompt/branding (today it is hard-coded "Xolver"), per-partner API keys (the `apiKeys.ts` key->clientId model already supports it), and a one-line `<script>` embed. Do not build these now.

## Output
Implement Step 3 in order. After each milestone, summarize what changed, what you verified (with evidence), and anything you could not confirm. Surface blockers (hosting accounts, DNS, a live Gemini key) early rather than guessing.

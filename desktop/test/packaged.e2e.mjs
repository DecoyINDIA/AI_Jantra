// Acceptance test for a packaged desktop build (D-001). Launches the real
// executable, drives its window over the Chrome DevTools Protocol (Node's
// built-in WebSocket, no extra dependencies) and checks that the bundled UI,
// embedded API, SQLite store and security policy all work, then relaunches to
// confirm persistence.
//
//   npm run dist -w @jantra/desktop -- --linux dir   (or any unpacked build)
//   xvfb-run -a node desktop/test/packaged.e2e.mjs [path/to/executable]
// Dev mode (after `npm run stage -w @jantra/desktop`):
//   xvfb-run -a node desktop/test/packaged.e2e.mjs node_modules/electron/dist/electron desktop
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof WebSocket !== "function") {
  console.error(`packaged-e2e: needs Node >= 22 for the global WebSocket (running ${process.version}).`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
// argv[2]: executable (packaged binary, or the electron binary for dev mode)
// argv[3]: optional app directory, for dev mode (`electron <desktop dir>`)
function defaultExecutable() {
  const release = join(here, "..", "release");
  if (process.platform === "win32") return join(release, "win-unpacked", "jantra.exe");
  if (process.platform === "darwin") {
    // mac/ on Intel, mac-arm64/ on Apple silicon.
    const dir = existsSync(release) ? readdirSync(release).find((d) => d.startsWith("mac")) : undefined;
    return join(release, dir ?? "mac", "Jantra.app", "Contents", "MacOS", "Jantra");
  }
  return join(release, "linux-unpacked", "jantra");
}
const exe = resolve(process.argv[2] ?? defaultExecutable());
const appDirArg = process.argv[3] ? [resolve(process.argv[3])] : [];
if (!existsSync(exe)) {
  console.error(`packaged-e2e: executable not found: ${exe}`);
  process.exit(2);
}

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A license signed by a throwaway key; the runtime trusts it via
// JANTRA_LICENSE_PUBLIC_KEY, exactly as an operator override would.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const payload = {
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  issuedAt: new Date().toISOString(),
  licensee: "packaged-e2e",
  plan: "test",
};
const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64");
const token = Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64");

const home = mkdtempSync(join(tmpdir(), "jantra-packaged-"));
// --user-data-dir pins app.getPath("userData") identically on every platform
// (macOS ignores HOME for its Application Support lookup).
const userData = join(home, "userData");
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "license.json"), JSON.stringify({ token }));

const freePort = () =>
  new Promise((res) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

async function launch() {
  const port = await freePort();
  const child = spawn(exe, [...appDirArg, "--no-sandbox", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      HOME: home,
      JANTRA_LICENSE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const listTargets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page;
  for (let i = 0; i < 150 && !page; i++) {
    await sleep(200);
    try {
      page = (await listTargets()).find((t) => t.type === "page" && t.url.startsWith("app://jantra/"));
    } catch {
      // DevTools endpoint not up yet.
    }
  }
  if (!page) {
    child.kill("SIGKILL");
    throw new Error(`app window never loaded app://jantra/. Output:\n${output.slice(-2000)}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(String(msg.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    } else if (data.method) {
      events.push(data);
    }
  };
  let closedReason = null;
  ws.onclose = (event) => {
    closedReason = `DevTools socket closed (${event.code})`;
    for (const resolvePending of pending.values()) resolvePending({ error: { message: closedReason } });
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      if (closedReason) return rej(new Error(closedReason));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP ${method} timed out`));
      }, 20_000);
      pending.set(id, (data) => {
        clearTimeout(timer);
        if (data.error) rej(new Error(`${method}: ${data.error.message}`));
        else res(data);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result?.result?.value;
  };
  const close = async () => {
    ws.close();
    child.kill("SIGTERM");
    await new Promise((res) => {
      const t = setTimeout(() => (child.kill("SIGKILL"), res()), 5000);
      child.on("exit", () => (clearTimeout(t), res()));
    });
  };
  return { send, evaluate, events, listTargets, close, output: () => output };
}

const api = (path, init = {}) => `(async () => {
  const d = window.JANTRA_DESKTOP;
  const r = await fetch(d.baseUrl + ${JSON.stringify(path)}, {
    ...${JSON.stringify(init)},
    headers: { authorization: "Bearer " + d.token, "content-type": "application/json" },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
})()`;

let runId;
try {
  const first = await launch();
  try {
    await sleep(1500);
    const page = await first.evaluate(`({ url: location.href, rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0, text: document.body.innerText.slice(0, 80) })`);
    // The UI only renders if its scripts and styles loaded under the CSP.
    check("UI loads from app://jantra and renders under its CSP", page.url === "app://jantra/index.html" && page.rendered && /Jantra/.test(page.text), page);

    const inline = await first.evaluate(`new Promise((resolve) => {
      window.__inlineRan = false;
      const s = document.createElement("script");
      s.textContent = "window.__inlineRan = true";
      document.head.append(s);
      setTimeout(() => resolve(window.__inlineRan), 300);
    })`);
    check("CSP blocks injected inline script in the console", inline === false, inline);

    const bridge = await first.evaluate(`({ base: window.JANTRA_DESKTOP?.baseUrl, hasToken: Boolean(window.JANTRA_DESKTOP?.token) })`);
    check("desktop bridge provides API URL and token", /^http:\/\/127\.0\.0\.1:\d+$/.test(bridge.base ?? "") && bridge.hasToken, bridge);

    // /health has no CORS headers (it is outside /v1), so probe reachability
    // with an opaque request; the authenticated /v1 checks below read data.
    const health = await first.evaluate(`fetch(window.JANTRA_DESKTOP.baseUrl + "/health", { mode: "no-cors" }).then((r) => r.type, (e) => String(e))`);
    check("embedded API is up", health === "opaque", health);

    const agents = await first.evaluate(api("/v1/agents"));
    check("UI origin can call the API (CORS + loopback token)", agents.status === 200, agents.status);

    const created = await first.evaluate(api("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "intake-public", title: "packaged e2e" }) }));
    runId = created.body?.run?.id;
    check("licensed run creation writes to SQLite", created.status === 200 && typeof runId === "string", created);

    const csp = await first.evaluate(`fetch("app://jantra/index.html").then((r) => r.headers.get("content-security-policy"))`);
    check("console is served with its CSP", /default-src 'self'/.test(csp ?? "") && /frame-ancestors 'none'/.test(csp ?? ""), csp);

    const traversal = await first.evaluate(`Promise.all(["app://jantra/../../../etc/passwd", "app://jantra/%2e%2e/%2e%2e/etc/passwd", "app://jantra/..%2f..%2fetc%2fpasswd"].map((u) => fetch(u).then((r) => r.status, () => "blocked")))`);
    check("app:// cannot read outside the web root", traversal.every((s) => s === 404 || s === "blocked"), traversal);

    const before = (await first.listTargets()).filter((t) => t.type === "page").length;
    const opened = await first.evaluate(`window.open("https://evil.example/") === null`);
    await sleep(500);
    const after = (await first.listTargets()).filter((t) => t.type === "page").length;
    check("external window.open does not open in-app", opened && after === before, { opened, before, after });
  } finally {
    await first.close();
  }

  const second = await launch();
  try {
    await sleep(1000);
    const runs = await second.evaluate(api("/v1/runs"));
    const items = runs.body?.items ?? runs.body?.runs ?? [];
    check("run survives an app restart (SQLite persisted)", runs.status === 200 && JSON.stringify(items).includes(runId), { status: runs.status, runId });
  } finally {
    await second.close();
  }
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures.length ? `packaged-e2e: ${failures.length} FAILED` : "packaged-e2e: all checks passed");
process.exit(failures.length ? 1 : 0);

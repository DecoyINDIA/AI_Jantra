import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

let baseUrl = (process.env.JANTRA_EDGE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const allowedOrigin = process.env.JANTRA_EDGE_TEST_ORIGIN ?? "http://localhost:5176";
const badOrigin = process.env.JANTRA_EDGE_BAD_ORIGIN ?? "https://blocked.example";
const expectRateLimit = process.env.JANTRA_EDGE_EXPECT_RATE_LIMIT !== "0";
const rateLimitAttempts = Number(process.env.JANTRA_EDGE_RATE_LIMIT_ATTEMPTS ?? "25");
const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
const isLocal =
  process.argv.includes("--local") ||
  process.env.JANTRA_EDGE_LOCAL === "1" ||
  !process.env.JANTRA_EDGE_URL;

const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function edgeFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("Origin", init.origin ?? allowedOrigin);
  headers.set("CF-Connecting-IP", init.ip ?? testIp);
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

async function readBody(response) {
  const text = await response.text();
  try {
    return { text, json: text ? JSON.parse(text) : undefined };
  } catch {
    return { text, json: undefined };
  }
}

async function expectStatus(label, response, expected) {
  const body = await readBody(response);
  assert(
    response.status === expected,
    `${label}: expected ${expected}, got ${response.status}: ${body.text}`,
  );
  results.push({ label, status: response.status });
  return body.json;
}

async function expectBlocked(label, response) {
  const body = await readBody(response);
  assert(
    response.status !== 200,
    `${label}: expected a blocked response, got 200: ${body.text}`,
  );
  results.push({ label, status: response.status });
  return body.json;
}

async function startLocalHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-edge-verify-"));
  process.env.JANTRA_DATA_DIR = tmpDir;
  process.env.JANTRA_PROVIDER = "mock";
  process.env.JANTRA_MOCK_FIXTURE = path.resolve("src/runtime/evals/fixtures/transcript.json");

  const { createServer } = await import("../../src/server/app.js");
  const { JsonProjectStore } = await import("../../src/pipeline/store.js");
  const { parseApiKeyRecords } = await import("../../src/server/auth/apiKeys.js");
  const worker = (await import("./worker.js")).default;

  const originApiKey = "edge-test-key";
  const store = new JsonProjectStore(tmpDir);
  const originServer = createServer({
    mode: "remote",
    loopbackToken: "unused-token",
    apiKeys: parseApiKeyRecords(`${originApiKey}:xolver:web`),
    store,
    checkCatalogModels: false,
  });
  await originServer.listen({ host: "127.0.0.1", port: 0 });
  const originPort = originServer.server.address().port;
  const originUrl = `http://127.0.0.1:${originPort}`;

  const counts = new Map();
  const workerEnv = {
    JANTRA_ORIGIN: originUrl,
    ALLOWED_ORIGINS: allowedOrigin,
    JANTRA_API_KEY: originApiKey,
    RATE_LIMITER: {
      async limit({ key }) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { success: count <= 15 };
      },
    },
  };

  const workerServer = http.createServer(async (req, res) => {
    try {
      const fullUrl = `http://${req.headers.host || "127.0.0.1"}${req.url}`;
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const webHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) {
          if (Array.isArray(v)) {
            for (const item of v) webHeaders.append(k, item);
          } else {
            webHeaders.set(k, v);
          }
        }
      }
      const webRequest = new Request(fullUrl, {
        method: req.method,
        headers: webHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        duplex: "half",
      });

      const webResponse = await worker.fetch(webRequest, workerEnv);
      res.statusCode = webResponse.status;
      for (const [k, v] of webResponse.headers.entries()) {
        res.setHeader(k, v);
      }
      const arrayBuffer = await webResponse.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  const workerPort = workerServer.address().port;
  baseUrl = `http://127.0.0.1:${workerPort}`;

  return async function cleanup() {
    await new Promise((resolve) => workerServer.close(resolve));
    await originServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
}

async function main() {
  let cleanup;
  if (isLocal) {
    cleanup = await startLocalHarness();
  }
  try {
  const created = await expectStatus(
    "create_run",
    await edgeFetch("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "intake-public",
        title: "Edge verification intake",
      }),
    }),
    200,
  );
  const runId = created?.run?.id;
  assert(typeof runId === "string" && runId.length > 0, "create_run: missing run.id");

  const advanced = await expectStatus(
    "advance_bodyless",
    await edgeFetch(`/v1/runs/${runId}/advance`, { method: "POST" }),
    200,
  );
  const interactionId = advanced?.step?.interaction?.id;
  assert(
    advanced?.step?.status === "awaiting_input",
    `advance_bodyless: expected awaiting_input, got ${advanced?.step?.status}`,
  );
  assert(
    typeof interactionId === "string" && interactionId.length > 0,
    "advance_bodyless: missing interaction.id",
  );

  const answered = await expectStatus(
    "answer_interaction",
    await edgeFetch(`/v1/runs/${runId}/interactions/${interactionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          "A reconciliation copilot for small ecommerce finance teams that connects Shopify, Stripe, and QuickBooks, then explains payout mismatches before month end.",
      }),
    }),
    200,
  );
  assert(
    answered?.step?.status === "awaiting_confirmation",
    `answer_interaction: expected awaiting_confirmation, got ${answered?.step?.status}`,
  );
  const ideaSummary = answered.step.artifacts?.find((artifact) => artifact.kind === "idea_summary");
  assert(ideaSummary?.content, "answer_interaction: missing idea_summary artifact");
  results.push({ label: "idea_summary_present", status: "ok", title: ideaSummary.title });

  await expectStatus(
    "oversized_json",
    await edgeFetch("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "intake-public", title: "x".repeat(17 * 1024) }),
    }),
    413,
  );

  await expectStatus(
    "non_json_body",
    await edgeFetch("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    }),
    415,
  );

  const blockedRoutes = [
    ["block_tenant_run_list", "/v1/runs", { method: "GET" }],
    ["block_audit", `/v1/runs/${runId}/audit`, { method: "GET" }],
    ["block_artifact", `/v1/runs/${runId}/artifacts/idea_summary`, { method: "GET" }],
    ["block_sources", `/v1/runs/${runId}/sources`, { method: "GET" }],
    ["block_agent_registry", "/v1/agents", { method: "GET" }],
    ["block_agent_detail", "/v1/agents/intake-public", { method: "GET" }],
    ["block_confirm", `/v1/runs/${runId}/confirm`, { method: "POST" }],
    ["block_reject", `/v1/runs/${runId}/reject`, { method: "POST" }],
    ["block_admin_keys_get", "/v1/admin/keys", { method: "GET" }],
    [
      "block_admin_keys_post",
      "/v1/admin/keys",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ],
  ];
  for (const [label, path, init] of blockedRoutes) {
    await expectBlocked(label, await edgeFetch(path, init));
  }

  await expectStatus(
    "missing_origin",
    await edgeFetch(`/v1/runs/${runId}`, { method: "GET", origin: null }),
    403,
  );
  await expectStatus(
    "bad_origin",
    await edgeFetch(`/v1/runs/${runId}`, { method: "GET", origin: badOrigin }),
    403,
  );

  if (expectRateLimit) {
    let rateLimitedStatus = null;
    for (let i = 0; i < rateLimitAttempts; i++) {
      const response = await edgeFetch(`/v1/runs/${runId}`, { method: "GET" });
      if (response.status === 429) {
        rateLimitedStatus = response.status;
        await response.text();
        break;
      }
      await response.text();
    }
    assert(rateLimitedStatus === 429, "rate_limit: expected a 429 response");
    results.push({ label: "rate_limit", status: 429 });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        edgeUrl: baseUrl,
        allowedOrigin,
        testIp,
        advanceStatus: 200,
        results,
      },
      null,
      2,
    ),
  );
  } finally {
    if (cleanup) await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

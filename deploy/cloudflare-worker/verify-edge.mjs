const baseUrl = (process.env.JANTRA_EDGE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const allowedOrigin = process.env.JANTRA_EDGE_TEST_ORIGIN ?? "http://localhost:5176";
const badOrigin = process.env.JANTRA_EDGE_BAD_ORIGIN ?? "https://blocked.example";
const expectRateLimit = process.env.JANTRA_EDGE_EXPECT_RATE_LIMIT !== "0";
const rateLimitAttempts = Number(process.env.JANTRA_EDGE_RATE_LIMIT_ATTEMPTS ?? "25");
const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

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

async function main() {
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

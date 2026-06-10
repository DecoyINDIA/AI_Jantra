process.env.JANTRA_PROVIDER ??= "mock";
process.env.JANTRA_AUDIT_DIR ??= ".jantra/server-smoke/audit";
process.env.JANTRA_PROJECT_DIR ??= ".jantra/server-smoke/projects";

export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const { createServer } = await import("./app.js");

const token = "smoke-token";
const app = createServer({
  loopbackToken: token,
  clientId: "xolver",
  allowedOrigins: ["http://127.0.0.1:5173"],
});

const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };

const missing = await app.inject({
  method: "GET",
  url: "/v1/agents",
  headers: { host: "127.0.0.1:4317" },
});
assert(missing.statusCode === 401, "Missing token was not rejected.");

const badHost = await app.inject({
  method: "GET",
  url: "/v1/agents",
  headers: { ...auth, host: "jantra.example.com" },
});
assert(badHost.statusCode === 403, "Unexpected Host header was not rejected.");

const badOrigin = await app.inject({
  method: "GET",
  url: "/v1/agents",
  headers: { ...auth, origin: "https://evil.example.com" },
});
assert(badOrigin.statusCode === 403, "Unexpected Origin header was not rejected.");

const agents = await app.inject({
  method: "GET",
  url: "/v1/agents",
  headers: auth,
});
assert(agents.statusCode === 200, "Agent catalog failed.");
assert(agents.json().agents.length >= 2, "Agent catalog did not include registered agents.");

const modelsResp = await app.inject({
  method: "GET",
  url: "/v1/models",
  headers: auth,
});
assert(modelsResp.statusCode === 200, "Model catalog failed.");
const modelList = modelsResp.json().models as Array<{ id: string; available: boolean }>;
assert(
  modelList.some((model) => model.id === "gemini-2.5-flash"),
  "Model catalog did not include gemini-2.5-flash.",
);

const badModel = await app.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    agentId: "planning-pipeline",
    title: "Bad model run",
    modelId: "not-a-real-model",
  },
});
assert(badModel.statusCode === 400, `Invalid modelId was not rejected: ${badModel.body}`);

const created = await app.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    agentId: "planning-pipeline",
    title: "Smoke API run",
    modelId: "gemini-2.5-pro",
  },
});
assert(created.statusCode === 200, `Run create failed: ${created.body}`);
assert(
  created.json().run.modelId === "gemini-2.5-pro",
  "Run did not persist the selected modelId.",
);
const runId = created.json().run.id as string;

const listed = await app.inject({
  method: "GET",
  url: "/v1/runs?limit=1",
  headers: auth,
});
assert(listed.statusCode === 200, "Run list failed.");
assert(listed.json().items.length === 1, "Run list did not page results.");

const detail = await app.inject({
  method: "GET",
  url: `/v1/runs/${runId}`,
  headers: auth,
});
assert(detail.statusCode === 200, "Run detail failed.");

const advance = await app.inject({
  method: "POST",
  url: `/v1/runs/${runId}/advance`,
  headers: auth,
});
assert(
  advance.statusCode === 200 && advance.json().step.status === "awaiting_input",
  `Advance did not return a pending Intake interaction: ${advance.body}`,
);
const interactionId = advance.json().step.interaction.id as string;

const interactions = await app.inject({
  method: "GET",
  url: `/v1/runs/${runId}/interactions`,
  headers: auth,
});
assert(interactions.statusCode === 200, "Interaction list failed.");
assert(interactions.json().interactions.length === 1, "Pending interaction was not listed.");

const answered = await app.inject({
  method: "POST",
  url: `/v1/runs/${runId}/interactions/${interactionId}`,
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    text: "A tool for small finance teams that reconciles Shopify orders, Stripe payments, and QuickBooks invoices every morning.",
  },
});
assert(
  answered.statusCode === 200 && answered.json().step.status === "awaiting_confirmation",
  `Answering Intake did not reach the stage gate: ${answered.body}`,
);

const audit = await app.inject({
  method: "GET",
  url: `/v1/runs/${runId}/audit`,
  headers: auth,
});
assert(audit.statusCode === 200, "Audit page failed.");

const supportCreated = await app.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    agentId: "support-agent",
    title: "Support smoke",
  },
});
assert(supportCreated.statusCode === 200, `Support run create failed: ${supportCreated.body}`);
const supportRunId = supportCreated.json().run.id as string;

const supportStart = await app.inject({
  method: "POST",
  url: `/v1/runs/${supportRunId}/advance`,
  headers: auth,
});
assert(
  supportStart.statusCode === 200 && supportStart.json().step.status === "awaiting_input",
  `Support start did not return a request interaction: ${supportStart.body}`,
);
const requestInteractionId = supportStart.json().step.interaction.id as string;

const supportRequest = await app.inject({
  method: "POST",
  url: `/v1/runs/${supportRunId}/interactions/${requestInteractionId}`,
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    text: "The lamp on order A-1001 arrived cracked. Please refund it.",
  },
});
assert(
  supportRequest.statusCode === 200 &&
    supportRequest.json().step.status === "awaiting_input" &&
    supportRequest.json().step.interaction.kind === "approval",
  `Support request did not pause for approval: ${supportRequest.body}`,
);
const approvalInteractionId = supportRequest.json().step.interaction.id as string;

const supportApproval = await app.inject({
  method: "POST",
  url: `/v1/runs/${supportRunId}/interactions/${approvalInteractionId}`,
  headers: { ...auth, "content-type": "application/json" },
  payload: {
    approved: true,
  },
});
assert(
  supportApproval.statusCode === 200 &&
    supportApproval.json().step.status === "awaiting_confirmation",
  `Support approval did not reach the stage gate: ${supportApproval.body}`,
);

await app.close();
console.log("Server smoke PASS: auth, Host/Origin checks, catalog, runs, and audit route work.");

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "../../../agent.js";
import { AuditLogger } from "../../../audit.js";
import { config, resolveDataDirs } from "../../../config.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { JsonProjectStore } from "../../../pipeline/store.js";
import { createServer } from "../../../server/app.js";
import { JsonLeadStore } from "../../../server/leads/store.js";
import { createAdminApiKeyBodySchema, parseWith } from "../../../server/schemas.js";
import { assertPublicWebhookUrl } from "../../../server/webhooks/urlGuard.js";
import { JsonWebhookSubscriptionStore } from "../../../server/webhooks/store.js";
import type { AnyTool } from "../../../types.js";
import { isBlockedAddress } from "../../../util/netGuard.js";
import { nextRequest, safeFetch, UnsafeUrlError } from "../../../util/safeFetch.js";
import { assert, readAuditJsonl, result, SequenceProvider } from "./common.js";

export async function verifyAuditRedactionAndTruncation(): Promise<void> {
  const secretTool: AnyTool = {
    name: "secret_tool",
    description: "Uses secret-looking inputs.",
    inputSchema: { type: "object" },
    risk: "read",
    run: () => ({ content: "ok" }),
  };
  const agent = new Agent({
    spec: {
      name: "audit-redaction",
      systemPrompt: "Call the tool once.",
      tools: [secretTool],
    },
    provider: new SequenceProvider([
      result("", [
        {
          id: "secret-call",
          name: "secret_tool",
          args: {
            password: "p@ssword",
            apiKey: "jantra-secret",
            normal: "visible",
          },
        },
      ]),
      result("done"),
    ]),
  });
  const run = await agent.run("use the secret tool");
  const toolCall = readAuditJsonl(run.runId).find(
    (entry) => entry.type === "tool_call" && entry.toolName === "secret_tool",
  );
  assert(toolCall, "Tool call audit entry was not written.");
  const input = toolCall.input as Record<string, unknown>;
  assert(
    input.password === "[redacted]" &&
      input.apiKey === "[redacted]" &&
      input.normal === "visible",
    "Tool-call input secrets were not redacted shallowly.",
  );

  const audit = new AuditLogger(`audit-truncation-${Date.now()}`, config.auditDir);
  audit.record("tool_result", {
    toolName: "large_tool",
    content: "x".repeat(config.auditMaxFieldBytes * 4),
  });
  const [entry] = readAuditJsonl(audit.runId);
  assert(entry, "Large audit entry was not written.");
  const content = entry.content;
  assert(typeof content === "string", "Large audit content did not serialize as a string.");
  assert(content.includes("[truncated"), "Large audit content did not include a truncation marker.");
  assert(
    Buffer.byteLength(content, "utf8") <= config.auditMaxFieldBytes,
    "Large audit field exceeded the configured field cap.",
  );
}

export async function verifyWebhookUrlGuard(): Promise<void> {
  const badUrls = [
    "http://169.254.169.254/",
    "http://localhost/",
    "http://127.0.0.1:9999/",
    "ftp://example.com/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://[64:ff9b::7f00:1]/",
    "http://foo.localhost/",
  ];
  for (const url of badUrls) {
    let rejected = false;
    try {
      await assertPublicWebhookUrl(url);
    } catch {
      rejected = true;
    }
    assert(rejected, `assertPublicWebhookUrl did not reject unsafe URL: ${url}`);
  }

  // Unit assertions on isBlockedAddress
  assert(isBlockedAddress("127.0.0.1") === true, "127.0.0.1 should be blocked");
  assert(isBlockedAddress("10.1.2.3") === true, "10.1.2.3 should be blocked");
  assert(isBlockedAddress("169.254.169.254") === true, "169.254.169.254 should be blocked");
  assert(isBlockedAddress("::1") === true, "::1 should be blocked");
  assert(isBlockedAddress("fd00::1") === true, "fd00::1 should be blocked");
  assert(isBlockedAddress("::ffff:10.0.0.1") === true, "::ffff:10.0.0.1 should be blocked");

  assert(isBlockedAddress("1.1.1.1") === false, "1.1.1.1 should be allowed");
  assert(isBlockedAddress("8.8.8.8") === false, "8.8.8.8 should be allowed");
  assert(isBlockedAddress("2606:4700:4700::1111") === false, "2606:4700:4700::1111 should be allowed");

  // safeFetch rejects user:pass in URL
  let userPassRejected = false;
  try {
    await safeFetch("http://user:pass@1.1.1.1/");
  } catch (err) {
    if (err instanceof UnsafeUrlError) userPassRejected = true;
  }
  assert(userPassRejected, "safeFetch did not reject user:pass in URL");

  // A public URL should resolve successfully without throwing.
  let allowed = false;
  try {
    await assertPublicWebhookUrl("http://1.1.1.1/");
    allowed = true;
  } catch {
    allowed = false;
  }
  assert(allowed, "assertPublicWebhookUrl rejected a valid public IP URL.");
}

export async function verifySafeFetchRedirect(): Promise<void> {
  const r1 = nextRequest("https://example.com/dir/page", 302, "other", "POST");
  assert(r1.url === "https://example.com/dir/other", "Relative location did not resolve");
  assert(r1.method === "GET", "302 on POST did not switch to GET");
  assert(r1.dropBody === true, "302 on POST did not drop body");

  const r2 = nextRequest("https://example.com/foo", 303, "/bar", "POST");
  assert(r2.url === "https://example.com/bar", "303 relative location mismatch");
  assert(r2.method === "GET", "303 should switch to GET");
  assert(r2.dropBody === true, "303 should drop body");

  const r3 = nextRequest("https://example.com/start", 307, "/next", "POST");
  assert(r3.url === "https://example.com/next", "307 relative location mismatch");
  assert(r3.method === "POST", "307 should preserve method");
  assert(r3.dropBody === false, "307 should keep body");

  let missingLocationThrew = false;
  try {
    nextRequest("https://example.com/", 302, null, "GET");
  } catch (err) {
    if (err instanceof UnsafeUrlError) missingLocationThrew = true;
  }
  assert(missingLocationThrew, "Missing location header did not throw UnsafeUrlError");

  let loopbackRejected = false;
  try {
    await safeFetch("http://127.0.0.1:9/");
  } catch (err) {
    if (err instanceof UnsafeUrlError) loopbackRejected = true;
  }
  assert(loopbackRejected, "safeFetch did not reject loopback with UnsafeUrlError");
}

export function verifyDataRootDerivation(): void {
  const def = resolveDataDirs({});
  assert(def.dataDir === ".jantra", "Default dataDir should be .jantra");
  assert(def.auditDir === ".jantra/audit", "Default auditDir should be .jantra/audit");
  assert(def.projectDir === ".jantra/projects", "Default projectDir should be .jantra/projects");
  assert(def.leadDir === ".jantra/leads", "Default leadDir should be .jantra/leads");
  assert(def.opsDataDir === ".jantra/ops", "Default opsDataDir should be .jantra/ops");

  const custom = resolveDataDirs({ JANTRA_DATA_DIR: "/data/jantra" });
  assert(custom.dataDir === "/data/jantra", "custom dataDir mismatch");
  assert(custom.auditDir === "/data/jantra/audit", "custom auditDir mismatch");
  assert(custom.projectDir === "/data/jantra/projects", "custom projectDir mismatch");
  assert(custom.leadDir === "/data/jantra/leads", "custom leadDir mismatch");
  assert(custom.opsDataDir === "/data/jantra/ops", "custom opsDataDir mismatch");

  const override = resolveDataDirs({ JANTRA_DATA_DIR: "/d/", JANTRA_LEAD_DIR: "/x" });
  assert(override.leadDir === "/x", "Override leadDir mismatch");
  assert(override.auditDir === "/d/audit", "Override auditDir mismatch with trailing slash handled");
}

export async function verifyPublicKeyScope(): Promise<void> {
  const store = new JsonProjectStore();
  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store,
    apiKeys: [
      { key: "pub-key", clientId: "t1", subject: "web" },
      { key: "full-key", clientId: "t1", subject: "ops" },
    ],
  });

  try {
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key" },
      payload: { agentId: "planning-pipeline" },
    });
    assert(res1.statusCode === 403, `Expected 403 for planning-pipeline, got ${res1.statusCode}`);
    assert((res1.json() as any).error?.code === "agent_not_allowed", "Expected agent_not_allowed code");

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key" },
      payload: { agentId: "intake-public", autonomy: "auto" },
    });
    assert(res2.statusCode === 403, `Expected 403 for autonomy:auto, got ${res2.statusCode}`);
    assert((res2.json() as any).error?.code === "autonomy_not_allowed", "Expected autonomy_not_allowed code");

    const res3 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key" },
      payload: { agentId: "intake-public", modelId: "gemini-2.5-pro" },
    });
    assert(res3.statusCode === 403, `Expected 403 for modelId pin, got ${res3.statusCode}`);
    assert((res3.json() as any).error?.code === "model_pin_not_allowed", "Expected model_pin_not_allowed code");

    const res4 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key" },
      payload: { agentId: "intake-public", title: "x" },
    });
    assert(res4.statusCode === 200, `Expected 200 for intake-public run creation, got ${res4.statusCode}: ${res4.body}`);
    assert((res4.json() as any).run?.agentId === "intake-public", "Expected intake-public agentId");

    const res5 = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key" },
    });
    assert(res5.statusCode === 403, `Expected 403 for GET /v1/runs with pub-key, got ${res5.statusCode}`);

    const res6 = await app.inject({
      method: "POST",
      url: "/v1/complete",
      headers: { authorization: "Bearer pub-key" },
      payload: { system: "s", user: "u" },
    });
    assert(res6.statusCode === 403, `Expected 403 for POST /v1/complete with pub-key, got ${res6.statusCode}`);

    const res7 = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { authorization: "Bearer pub-key" },
    });
    assert(res7.statusCode === 403, `Expected 403 for GET /v1/agents with pub-key, got ${res7.statusCode}`);

    const res8 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer full-key" },
      payload: { agentId: "planning-pipeline", title: "x" },
    });
    assert(res8.statusCode === 200, `Expected 200 for full-key run creation, got ${res8.statusCode}`);
    const planningRunId = (res8.json() as any).run?.id;
    assert(planningRunId, "Expected planning run id");

    const res9 = await app.inject({
      method: "GET",
      url: `/v1/runs/${planningRunId}`,
      headers: { authorization: "Bearer pub-key" },
    });
    assert(res9.statusCode === 403, `Expected 403 for pub-key GET on planning run, got ${res9.statusCode}`);
    assert((res9.json() as any).error?.code === "agent_not_allowed", "Expected agent_not_allowed code");

    const res10 = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { authorization: "Bearer full-key" },
    });
    assert(res10.statusCode === 200, `Expected 200 for full-key GET /v1/agents, got ${res10.statusCode}`);
  } finally {
    await app.close();
  }
}

export function verifyJsonStoreIgnoresNonProjectFiles(): void {
  const store = new JsonProjectStore();
  const clientId = `test-client-${Date.now()}`;
  const project = createProject({
    clientId,
    title: "T-008 Project",
    agentId: "planning-pipeline",
  });
  store.saveProject(project);

  const dir = path.join(config.projectDir, clientId);
  writeFileSync(path.join(dir, "webhooks.json"), "[]", "utf8");
  writeFileSync(path.join(dir, "garbage.json"), "{not json", "utf8");
  writeFileSync(path.join(dir, "other.json"), "{\"a\":1}", "utf8");

  const page = store.listProjects({ clientId });
  assert(page.items.length === 1, `Expected exactly 1 project item, got ${page.items.length}`);
  assert(page.items[0]?.id === project.id, `Expected project id ${project.id}, got ${page.items[0]?.id}`);
}

export function verifyStorePathSegments(): void {
  const webhookStore = new JsonWebhookSubscriptionStore();
  let webhookThrew = false;
  try {
    webhookStore.list("..");
  } catch {
    webhookThrew = true;
  }
  assert(webhookThrew, "JsonWebhookSubscriptionStore.list did not throw for unsafe clientId '..'");

  const leadStore = new JsonLeadStore();
  let leadThrew = false;
  try {
    leadStore.listLeadsByUser("..", "u");
  } catch {
    leadThrew = true;
  }
  assert(leadThrew, "JsonLeadStore.listLeadsByUser did not throw for unsafe clientId '..'");

  let parseThrew = false;
  try {
    parseWith(createAdminApiKeyBodySchema, {
      label: "x",
      clientId: "..",
      subject: "s",
    });
  } catch {
    parseThrew = true;
  }
  assert(parseThrew, "parseWith createAdminApiKeyBodySchema did not reject clientId '..'");

  const parsed = parseWith(createAdminApiKeyBodySchema, {
    label: "x",
    clientId: "acme-1",
    subject: "s",
  });
  assert(parsed.clientId === "acme-1", `Expected clientId 'acme-1', got ${parsed.clientId}`);
}

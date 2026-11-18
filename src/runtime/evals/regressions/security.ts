import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../../agent.js";
import { AuditLogger, auditChainHash, verifyAuditChainText } from "../../../audit.js";
import { decryptSecret, DecryptionError, encryptSecret } from "../../../security/encryption.js";
import { config, resolveDataDirs } from "../../../config.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { JsonProjectStore } from "../../../pipeline/store.js";
import { SqliteProjectStore } from "../../../pipeline/store/sqlite.js";
import { createServer } from "../../../server/app.js";
import { CLIENT_REPORT_CSP, markdownToHtml } from "../../../server/export/clientReport.js";
import { openEventStreamCount } from "../../../server/routes/events.js";
import { JsonLeadStore } from "../../../server/leads/store.js";
import { createAdminApiKeyBodySchema, parseWith } from "../../../server/schemas.js";
import { assertPublicWebhookUrl } from "../../../server/webhooks/urlGuard.js";
import { JsonWebhookSubscriptionStore } from "../../../server/webhooks/store.js";
import type { AnyTool } from "../../../types.js";
import { isBlockedAddress } from "../../../util/netGuard.js";
import { nextRequest, safeFetch, UnsafeUrlError } from "../../../util/safeFetch.js";
import { verifyWebhookSignature, webhookSignatureHeaders } from "../../../util/webhookSignature.js";
import { assert, readAuditJsonl, result, SequenceProvider, edgeHeaders } from "./common.js";

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
    checkCatalogModels: false,
    apiKeys: [
      { key: "pub-key", clientId: "t1", subject: "web" },
      { key: "full-key", clientId: "t1", subject: "ops" },
    ],
  });

  try {
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
      payload: { agentId: "planning-pipeline" },
    });
    assert(res1.statusCode === 403, `Expected 403 for planning-pipeline, got ${res1.statusCode}`);
    assert((res1.json() as any).error?.code === "agent_not_allowed", "Expected agent_not_allowed code");

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
      payload: { agentId: "intake-public", autonomy: "auto" },
    });
    assert(res2.statusCode === 403, `Expected 403 for autonomy:auto, got ${res2.statusCode}`);
    assert((res2.json() as any).error?.code === "autonomy_not_allowed", "Expected autonomy_not_allowed code");

    const res3 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
      payload: { agentId: "intake-public", modelId: "gemini-2.5-pro" },
    });
    assert(res3.statusCode === 403, `Expected 403 for modelId pin, got ${res3.statusCode}`);
    assert((res3.json() as any).error?.code === "model_pin_not_allowed", "Expected model_pin_not_allowed code");

    const res4 = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
      payload: { agentId: "intake-public", title: "x" },
    });
    assert(res4.statusCode === 200, `Expected 200 for intake-public run creation, got ${res4.statusCode}: ${res4.body}`);
    assert((res4.json() as any).run?.agentId === "intake-public", "Expected intake-public agentId");

    const res5 = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
    });
    assert(res5.statusCode === 403, `Expected 403 for GET /v1/runs with pub-key, got ${res5.statusCode}`);

    const res6 = await app.inject({
      method: "POST",
      url: "/v1/complete",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
      payload: { system: "s", user: "u" },
    });
    assert(res6.statusCode === 403, `Expected 403 for POST /v1/complete with pub-key, got ${res6.statusCode}`);

    const res7 = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
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
      headers: { authorization: "Bearer pub-key", ...edgeHeaders() },
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

export async function verifySsrfTransitionRanges(): Promise<void> {
  // IPv6 forms that embed or translate to an IPv4 address. Each one targets
  // loopback or a private range, so none may pass the guard.
  const embedded = [
    "::127.0.0.1",
    "::a9fe:a9fe",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2001:0:7f00:1::",
    "64:ff9b:1::a00:1",
    "fec0::1",
  ];
  for (const address of embedded) {
    assert(isBlockedAddress(address), `${address} should be blocked`);
    let rejected = false;
    try {
      await assertPublicWebhookUrl(`http://[${address}]/`);
    } catch {
      rejected = true;
    }
    assert(rejected, `assertPublicWebhookUrl accepted http://[${address}]/`);
  }

  // Legacy IPv4 spellings are normalized by the URL parser before the guard.
  for (const host of ["0x7f.1", "127.1", "2130706433", "0177.0.0.1", "0xa9.0xfe.0xa9.0xfe"]) {
    let rejected = false;
    try {
      await assertPublicWebhookUrl(`http://${host}/`);
    } catch {
      rejected = true;
    }
    assert(rejected, `assertPublicWebhookUrl accepted legacy IPv4 host ${host}`);
  }

  assert(!isBlockedAddress("2606:4700:4700::1111"), "Public IPv6 must stay allowed");
  assert(!isBlockedAddress("2a00:1450:4001::64"), "Public IPv6 must stay allowed");
}

export function verifyWebhookSignatureReplayProtection(): void {
  const secret = "whsec_regression_secret";
  const body = JSON.stringify({ id: "evt_1", type: "run.awaiting_confirmation" });
  const now = Date.parse("2026-01-01T00:00:00Z");
  const headers = webhookSignatureHeaders(secret, body, now);

  assert(
    headers["X-Jantra-Signature"] === createHmac("sha256", secret).update(body).digest("hex"),
    "V1 signature must stay HMAC(body) for existing receivers.",
  );
  const signed = {
    timestamp: headers["X-Jantra-Timestamp"],
    signatureV2: headers["X-Jantra-Signature-V2"],
  };
  assert(verifyWebhookSignature(secret, body, signed, { nowMs: now }).ok, "Fresh V2 signature must verify.");

  const tampered = verifyWebhookSignature(secret, body.replace("evt_1", "evt_2"), signed, { nowMs: now });
  assert(!tampered.ok && tampered.reason === "bad_signature", "Tampered body must fail.");

  const replayed = verifyWebhookSignature(secret, body, signed, { nowMs: now + 10 * 60_000 });
  assert(!replayed.ok && replayed.reason === "stale_timestamp", "Replay after tolerance must fail.");

  // Moving the timestamp forward without the secret must not re-validate it.
  const forged = verifyWebhookSignature(
    secret,
    body,
    { timestamp: String(Math.floor(now / 1000) + 600), signatureV2: signed.signatureV2 },
    { nowMs: now + 600_000 },
  );
  assert(!forged.ok && forged.reason === "bad_signature", "Re-stamped signature must fail.");

  const wrongSecret = verifyWebhookSignature("other-secret", body, signed, { nowMs: now });
  assert(!wrongSecret.ok, "Wrong secret must fail.");

  const missing = verifyWebhookSignature(secret, body, { timestamp: null, signatureV2: null });
  assert(!missing.ok && missing.reason === "missing_headers", "Missing headers must fail.");
}

export async function verifyEdgeSecretOriginLock(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const apiKeys = [
    { key: "pub-key", clientId: "t1", subject: "web" },
    { key: "full-key", clientId: "t1", subject: "ops" },
  ];
  const locked = createServer({
    mode: "remote",
    loopbackToken: "",
    store: new JsonProjectStore(tmp),
    checkCatalogModels: false,
    apiKeys,
    edgeSecret: "edge-secret-value",
  });
  const unlocked = createServer({
    mode: "remote",
    loopbackToken: "",
    store: new JsonProjectStore(tmp),
    checkCatalogModels: false,
    apiKeys,
    edgeSecret: "",
  });
  // A missing run returns 404 only after auth passes, so 404 means "allowed in".
  const probe = (app: typeof locked, headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/v1/runs/missing-run", headers });

  try {
    const noSecret = await probe(locked, { authorization: "Bearer pub-key" });
    assert(noSecret.statusCode === 403, `Public key without edge secret: expected 403, got ${noSecret.statusCode}`);

    const wrongSecret = await probe(locked, {
      authorization: "Bearer pub-key",
      "x-jantra-edge-secret": "edge-secret-valuX",
    });
    assert(wrongSecret.statusCode === 403, `Wrong edge secret: expected 403, got ${wrongSecret.statusCode}`);

    const viaEdge = await probe(locked, {
      authorization: "Bearer pub-key",
      "x-jantra-edge-secret": "edge-secret-value",
    });
    assert(viaEdge.statusCode === 404, `Public key via edge: expected 404, got ${viaEdge.statusCode}`);

    // Operators call the origin directly with full keys; the lock is public-only.
    const fullKey = await probe(locked, { authorization: "Bearer full-key" });
    assert(fullKey.statusCode === 404, `Full key without edge secret: expected 404, got ${fullKey.statusCode}`);

    // Fail closed: with no edge secret configured, public keys are refused
    // even if a caller sends some edge header.
    const unlockedPublic = await probe(unlocked, { authorization: "Bearer pub-key", ...edgeHeaders() });
    assert(
      unlockedPublic.statusCode === 403,
      `Unconfigured edge secret must refuse public keys: got ${unlockedPublic.statusCode}`,
    );
    const unlockedFull = await probe(unlocked, { authorization: "Bearer full-key" });
    assert(unlockedFull.statusCode === 404, `Full keys must still work without an edge secret: got ${unlockedFull.statusCode}`);
  } finally {
    await locked.close();
    await unlocked.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function verifyAuditHashChain(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const runId = "chain-run";
  const file = path.join(dir, `${runId}.jsonl`);
  const read = () => readFileSync(file, "utf8");
  const originalKey = config.auditHmacKey;
  try {
    // A pre-chain legacy line is tolerated as a prefix.
    writeFileSync(file, JSON.stringify({ ts: "2025-01-01T00:00:00Z", runId, type: "handoff" }) + "\n");

    // Two loggers on one file, interleaved, must share one chain.
    const first = new AuditLogger(runId, dir);
    const second = new AuditLogger(runId, dir);
    first.record("handoff", { clientId: "t1", note: "one" });
    second.record("handoff", { clientId: "t1", note: "two" });
    first.record("handoff", { clientId: "t1", note: "three", seq: 999, hash: "forged", prevHash: "x" });

    let report = verifyAuditChainText(read());
    assert(report.ok, `Fresh chain must verify: ${JSON.stringify(report)}`);
    assert(report.legacyEntries === 1 && report.headSeq === 3, `Unexpected chain shape: ${JSON.stringify(report)}`);

    // Another process appending a properly chained line: our cached head is
    // stale, and the next write must link to the new tail, not fork.
    const outsiderBody = {
      ts: new Date().toISOString(), runId, type: "handoff", clientId: "t1",
      seq: report.headSeq + 1, prevHash: report.headHash, hashAlg: "sha256",
    };
    const outsider = { ...outsiderBody, hash: auditChainHash(report.headHash, JSON.stringify(outsiderBody)) };
    writeFileSync(file, read() + JSON.stringify(outsider) + "\n");
    first.record("handoff", { clientId: "t1", note: "after outsider" });
    report = verifyAuditChainText(read());
    assert(report.ok && report.headSeq === 5, `Chain forked after external append: ${JSON.stringify(report)}`);

    const good = read();
    const lines = good.trimEnd().split("\n");

    const edited = good.replace('"note":"two"', '"note":"TWO"');
    report = verifyAuditChainText(edited);
    assert(!report.ok && report.brokenAtLine === 3, `Edited entry not caught: ${JSON.stringify(report)}`);

    const deleted = [...lines.slice(0, 2), ...lines.slice(3)].join("\n");
    report = verifyAuditChainText(deleted);
    assert(!report.ok, "Deleted middle entry not caught.");

    const reordered = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n");
    report = verifyAuditChainText(reordered);
    assert(!report.ok, "Reordered entries not caught.");

    const unchainedInsert = [...lines.slice(0, 3), JSON.stringify({ ts: "x", runId, type: "handoff" }), ...lines.slice(3)].join("\n");
    report = verifyAuditChainText(unchainedInsert);
    assert(!report.ok && report.reason === "unchained entry after chain start", "Inserted unchained entry not caught.");

    // HMAC mode: a writer without the key cannot produce a chain that verifies.
    (config as Record<string, unknown>).auditHmacKey = "audit-hmac-test-key";
    const keyedRun = "chain-run-keyed";
    const keyed = new AuditLogger(keyedRun, dir);
    keyed.record("handoff", { clientId: "t1" });
    keyed.record("handoff", { clientId: "t1" });
    const keyedText = readFileSync(path.join(dir, `${keyedRun}.jsonl`), "utf8");
    assert(verifyAuditChainText(keyedText, "audit-hmac-test-key").ok, "HMAC chain must verify with its key.");
    assert(!verifyAuditChainText(keyedText, "wrong-key").ok, "HMAC chain must fail with the wrong key.");
    assert(!verifyAuditChainText(keyedText, "").ok, "HMAC chain must not verify as plain SHA-256.");
  } finally {
    (config as Record<string, unknown>).auditHmacKey = originalKey;
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyAuditVerifyRoute(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store: new JsonProjectStore(tmp),
    checkCatalogModels: false,
    apiKeys: [
      { key: "pub-key", clientId: "t1", subject: "web" },
      { key: "full-key", clientId: "t1", subject: "ops" },
      { key: "other-key", clientId: "t2", subject: "ops" },
    ],
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer full-key" },
      payload: { agentId: "intake-public", title: "audit verify" },
    });
    assert(created.statusCode === 200, `Run create failed: ${created.statusCode} ${created.body}`);
    const runId = (created.json() as { run: { id: string } }).run.id;
    const url = `/v1/runs/${runId}/audit/verify`;

    const full = await app.inject({ method: "GET", url, headers: { authorization: "Bearer full-key" } });
    assert(full.statusCode === 200, `Full key verify: expected 200, got ${full.statusCode}`);
    const chain = (full.json() as { chain: { ok: boolean; headSeq: number } }).chain;
    assert(chain.ok && chain.headSeq >= 1, `New run's audit chain must verify: ${full.body}`);

    const pub = await app.inject({ method: "GET", url, headers: { authorization: "Bearer pub-key", ...edgeHeaders() } });
    assert(pub.statusCode === 403, `Public key verify: expected 403, got ${pub.statusCode}`);

    const other = await app.inject({ method: "GET", url, headers: { authorization: "Bearer other-key" } });
    assert(other.statusCode === 404 || other.statusCode === 403, `Cross-tenant verify: got ${other.statusCode}`);
  } finally {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function verifyPublicRunTokenBinding(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const store = new JsonProjectStore(tmp);
  const leadStore = new JsonLeadStore({ projectStore: store });
  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store,
    leadStore,
    checkCatalogModels: false,
    apiKeys: [
      { key: "pub-key", clientId: "t1", subject: "web" },
      { key: "full-key", clientId: "t1", subject: "ops" },
    ],
  });
  const pub = { authorization: "Bearer pub-key", ...edgeHeaders() };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: pub,
      payload: { agentId: "intake-public", title: "token binding" },
    });
    assert(created.statusCode === 200, `Public run create failed: ${created.body}`);
    const body = created.json() as { run: { id: string; visitorTokenHash?: string }; runToken?: string };
    const runId = body.run.id;
    const token = body.runToken;
    assert(typeof token === "string" && token.length >= 43, "Public run must return a 256-bit runToken.");
    assert(!JSON.stringify(body.run).includes(token), "The run record must not contain the raw token.");
    const stored = store.loadProject("t1", runId);
    assert(stored?.visitorTokenHash && stored.visitorTokenHash !== token, "Only the token hash may be persisted.");

    const withToken = { ...pub, "x-jantra-run-token": token };
    const wrongToken = { ...pub, "x-jantra-run-token": "A".repeat(43) };
    const checks: Array<[string, string, string, Record<string, string>, unknown, number]> = [
      ["read without token", "GET", `/v1/runs/${runId}`, pub, undefined, 404],
      ["read with wrong token", "GET", `/v1/runs/${runId}`, wrongToken, undefined, 404],
      ["interactions without token", "GET", `/v1/runs/${runId}/interactions`, pub, undefined, 404],
      ["advance without token", "POST", `/v1/runs/${runId}/advance`, pub, undefined, 404],
      ["answer without token", "POST", `/v1/runs/${runId}/interactions/x`, pub, { text: "hi" }, 404],
      ["read with token", "GET", `/v1/runs/${runId}`, withToken, undefined, 200],
      ["interactions with token", "GET", `/v1/runs/${runId}/interactions`, withToken, undefined, 200],
    ];
    for (const [label, method, url, headers, payload, expected] of checks) {
      const res = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers,
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });
      assert(res.statusCode === expected, `${label}: expected ${expected}, got ${res.statusCode} ${res.body}`);
    }

    // A wrong token looks exactly like a missing run (no existence oracle).
    const missing = await app.inject({ method: "GET", url: "/v1/runs/no-such-run", headers: withToken });
    const wrong = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: wrongToken });
    assert(
      missing.statusCode === wrong.statusCode &&
        (missing.json() as any).error?.code === (wrong.json() as any).error?.code,
      "Wrong-token and missing-run responses must match.",
    );

    // Leads: a public caller cannot attach a lead to a run it does not hold.
    const leadPayload = { name: "V", email: "v@example.com", idea: "x", source: "eval", runId };
    const hijack = await app.inject({ method: "POST", url: "/v1/leads", headers: pub, payload: leadPayload });
    assert(hijack.statusCode === 404, `Lead on foreign run: expected 404, got ${hijack.statusCode}`);
    const own = await app.inject({ method: "POST", url: "/v1/leads", headers: withToken, payload: leadPayload });
    assert(own.statusCode === 201, `Lead on own run: expected 201, got ${own.statusCode} ${own.body}`);

    // Operators are not bound by visitor tokens.
    const operator = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: { authorization: "Bearer full-key" },
    });
    assert(operator.statusCode === 200, `Full key read: expected 200, got ${operator.statusCode}`);

    // A run created by an operator has no visitor token, so public keys cannot open it.
    const opRun = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer full-key" },
      payload: { agentId: "intake-public", title: "operator run" },
    });
    const opBody = opRun.json() as { run: { id: string }; runToken?: string };
    assert(opBody.runToken === undefined, "Full-scope run creation must not issue a visitor token.");
    const pubOnOpRun = await app.inject({ method: "GET", url: `/v1/runs/${opBody.run.id}`, headers: pub });
    assert(pubOnOpRun.statusCode === 404, `Public read of operator run: expected 404, got ${pubOnOpRun.statusCode}`);
  } finally {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function verifyEnvReadsOnlyInConfig(): void {
  // AGENTS.md hard rule: configuration (including secrets) flows through
  // src/config.ts so it is validated in one place and never re-read ad hoc.
  // Test harnesses legitimately set env before importing config.
  const root = path.resolve("src");
  const allowed = (rel: string) =>
    rel === "config.ts" ||
    rel.endsWith(".test.ts") ||
    rel.startsWith(`runtime${path.sep}evals${path.sep}`) ||
    rel === path.join("server", "smoke.ts");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const rel = path.relative(root, full);
        if (!allowed(rel) && /process\.env\b/.test(readFileSync(full, "utf8"))) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert(offenders.length === 0, `process.env read outside src/config.ts: ${offenders.join(", ")}`);
}

export async function verifySecurityHeadersAndReportCsp(): Promise<void> {
  // Code-fence language tags land in a class attribute; only a safe charset survives.
  const fenced = markdownToHtml('```" onmouseover=alert(1) x="\ncode\n```');
  const codeClass = /<code class="([^"]*)">/.exec(fenced)?.[1] ?? "";
  assert(/^lang-[a-zA-Z0-9+#-]*$/.test(codeClass), `Unsafe code language tag survived: ${fenced}`);
  assert(!/\son\w+=/.test(fenced), `Event handler attribute in output: ${fenced}`);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store: new JsonProjectStore(tmp),
    checkCatalogModels: false,
    apiKeys: [{ key: "full-key", clientId: "t1", subject: "ops" }],
  });
  const auth = { authorization: "Bearer full-key" };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth,
      payload: { agentId: "intake-public", title: "<script>alert(1)</script>" },
    });
    assert(created.statusCode === 200, `Run create failed: ${created.body}`);
    for (const header of ["x-content-type-options", "x-frame-options", "referrer-policy"]) {
      assert(Boolean(created.headers[header]), `JSON response missing ${header}`);
    }
    assert(created.headers["x-content-type-options"] === "nosniff", "nosniff must be set");

    const runId = (created.json() as { run: { id: string } }).run.id;
    const exported = await app.inject({ method: "GET", url: `/v1/runs/${runId}/export`, headers: auth });
    assert(exported.statusCode === 200, `Export failed: ${exported.statusCode}`);
    const csp = String(exported.headers["content-security-policy"] ?? "");
    assert(csp === CLIENT_REPORT_CSP, `Export must carry the report CSP, got: ${csp}`);
    assert(/default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp), "CSP must deny by default and framing");
    assert(!/script-src[^;]*'unsafe-inline'/.test(csp), "CSP must not allow arbitrary inline script");
    assert(exported.headers["referrer-policy"] === "no-referrer", "Export must not leak its URL via Referer");
    assert(!exported.body.includes("<script>alert(1)</script>"), "Run title must be escaped in the export");
    // Blob: copies of the report (web console) carry no headers, so the
    // policy must also be the first thing in <head>.
    const head = exported.body.slice(0, exported.body.indexOf("<title>"));
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(head)?.[1] ?? "";
    assert(/default-src 'none'/.test(meta) && /script-src 'unsafe-hashes' 'sha256-/.test(meta), `Report must embed its CSP before any content, got: ${meta}`);
  } finally {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function verifyCredentialEncryptionStrictness(): void {
  const key = Buffer.alloc(32, 7);
  const blob = encryptSecret("stripe-secret-value", key);
  assert(decryptSecret(blob, key) === "stripe-secret-value", "Round trip must work.");

  const [version, iv, tag, data] = blob.split(":") as [string, string, string, string];
  const rejects = (candidate: string, label: string) => {
    let threw = false;
    try {
      decryptSecret(candidate, key);
    } catch (err) {
      threw = err instanceof DecryptionError;
    }
    assert(threw, `${label} must be rejected with DecryptionError.`);
  };
  // Node would otherwise verify only the first 4 bytes of a truncated tag.
  rejects(`${version}:${iv}:${tag.slice(0, 8)}:${data}`, "4-byte GCM tag");
  rejects(`${version}:${iv}:${tag.slice(0, 24)}:${data}`, "12-byte GCM tag");
  rejects(`${version}:${iv.slice(0, 16)}:${tag}:${data}`, "short IV");
  rejects(`${version}:${iv}:${tag}:${data}0`, "odd-length ciphertext");
  const flipped = (Number.parseInt(data.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0") + data.slice(2);
  rejects(`${version}:${iv}:${tag}:${flipped}`, "tampered ciphertext");
  rejects(blob.replace(/^v1/, "v2"), "unknown version");
  let wrongKey = false;
  try {
    decryptSecret(blob, Buffer.alloc(32, 8));
  } catch (err) {
    wrongKey = err instanceof DecryptionError;
  }
  assert(wrongKey, "Wrong key must be rejected.");
}

export async function verifyEventStreamLimits(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const original = { per: config.sseMaxPerIdentity, total: config.sseMaxTotal };
  (config as Record<string, unknown>).sseMaxPerIdentity = 2;
  (config as Record<string, unknown>).sseMaxTotal = 3;
  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store: new JsonProjectStore(tmp),
    checkCatalogModels: false,
    apiKeys: [
      { key: "key-a", clientId: "t1", subject: "ops-a" },
      { key: "key-b", clientId: "t1", subject: "ops-b" },
    ],
  });
  const sockets: http.ClientRequest[] = [];
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer key-a" },
      payload: { agentId: "intake-public", title: "sse" },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    // Resolves with the status once headers arrive; keeps 200 streams open.
    const open = (key: string) =>
      new Promise<{ status: number; req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: `/v1/runs/${runId}/events`, headers: { authorization: `Bearer ${key}` } },
          (res) => {
            if (res.statusCode !== 200) res.resume();
            resolve({ status: res.statusCode ?? 0, req, res });
          },
        );
        req.on("error", reject);
        sockets.push(req);
      });

    const a1 = await open("key-a");
    const a2 = await open("key-a");
    const a3 = await open("key-a");
    assert(a1.status === 200 && a2.status === 200, `First streams must open: ${a1.status}, ${a2.status}`);
    assert(a3.status === 429, `Per-identity cap: expected 429, got ${a3.status}`);
    assert(a1.res.headers["x-content-type-options"] === "nosniff", "SSE responses must carry nosniff");

    const b1 = await open("key-b");
    assert(b1.status === 200, `Other identity under the global cap must open: ${b1.status}`);
    const b2 = await open("key-b");
    assert(b2.status === 429, `Global cap: expected 429, got ${b2.status}`);
    assert(openEventStreamCount() === 3, `Expected 3 open streams, got ${openEventStreamCount()}`);

    // Closing a stream frees its slot.
    a1.req.destroy();
    for (let i = 0; i < 50 && openEventStreamCount() !== 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert(openEventStreamCount() === 2, `Closed stream must release its slot, count=${openEventStreamCount()}`);
    const a4 = await open("key-a");
    assert(a4.status === 200, `Slot must be reusable after close, got ${a4.status}`);
  } finally {
    for (const req of sockets) req.destroy();
    await app.close();
    (config as Record<string, unknown>).sseMaxPerIdentity = original.per;
    (config as Record<string, unknown>).sseMaxTotal = original.total;
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function verifyCredentialRecordBinding(): void {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jantra-"));
  const originalKey = config.secretsKey;
  (config as Record<string, unknown>).secretsKey = "a".repeat(64);
  try {
    const store = new SqliteProjectStore(path.join(tmp, "jantra.sqlite"), { projectDir: tmp, skipImport: true });
    store.setConnectorCredentials("tenant-a", "stripe", { apiKey: "sk_a" });
    store.setConnectorCredentials("tenant-b", "stripe", { apiKey: "sk_b" });
    const db = (store as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): any; run(...a: unknown[]): unknown } } }).db;
    const blobOf = (client: string, connector: string) =>
      db.prepare("select encrypted_blob from connector_credentials where client_id = ? and connector = ?").get(client, connector)
        .encrypted_blob as string;
    assert(blobOf("tenant-a", "stripe").startsWith("v2:"), "New credentials must be record-bound (v2).");

    // An attacker with database write access copies tenant A's blob into B's row.
    db.prepare("update connector_credentials set encrypted_blob = ? where client_id = ? and connector = ?").run(
      blobOf("tenant-a", "stripe"), "tenant-b", "stripe",
    );
    let swapped = false;
    try {
      store.getConnectorCredentials("tenant-b", "stripe");
    } catch (err) {
      swapped = err instanceof DecryptionError;
    }
    assert(swapped, "A blob moved to another tenant's row must fail to decrypt.");

    // Same tenant, different connector is a different record too.
    store.setConnectorCredentials("tenant-a", "shopify", { token: "shp" });
    db.prepare("update connector_credentials set encrypted_blob = ? where client_id = ? and connector = ?").run(
      blobOf("tenant-a", "stripe"), "tenant-a", "shopify",
    );
    let crossConnector = false;
    try {
      store.getConnectorCredentials("tenant-a", "shopify");
    } catch (err) {
      crossConnector = err instanceof DecryptionError;
    }
    assert(crossConnector, "A blob moved to another connector must fail to decrypt.");

    // Legacy v1 rows still read, and are upgraded to v2 at startup.
    const key = Buffer.from("a".repeat(64), "hex");
    db.prepare("update connector_credentials set encrypted_blob = ? where client_id = ? and connector = ?").run(
      encryptSecret(JSON.stringify({ apiKey: "sk_b" }), key), "tenant-b", "stripe",
    );
    assert(blobOf("tenant-b", "stripe").startsWith("v1:"), "Fixture must be legacy v1.");
    const upgraded = store.upgradeLegacyCredentials();
    assert(upgraded === 1 && blobOf("tenant-b", "stripe").startsWith("v2:"), `Legacy row must be upgraded (upgraded=${upgraded}).`);
    assert(store.getConnectorCredentials("tenant-b", "stripe")?.apiKey === "sk_b", "Upgraded credential must still read.");

    // A v2 blob cannot be read without its record context.
    let contextless = false;
    try {
      decryptSecret(blobOf("tenant-b", "stripe"), key);
    } catch (err) {
      contextless = err instanceof DecryptionError;
    }
    assert(contextless, "v2 blobs must require their record context.");
    store.close();
  } finally {
    (config as Record<string, unknown>).secretsKey = originalKey;
    rmSync(tmp, { recursive: true, force: true });
  }
}

import * as path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { opsReportingDefinition } from "../../../agents/opsReporting.js";
import { AuditLogger } from "../../../audit.js";
import { config } from "../../../config.js";
import { resolveClientDataDir } from "../../../pipeline/ops/connectors/csv.js";
import { createProject } from "../../../pipeline/orchestrator.js";
import { runOpsDeliver, runOpsIngest, syntheticDataAllowed } from "../../../pipeline/stages/opsReporting.js";
import { JsonProjectStore } from "../../../pipeline/store.js";
import { SqliteProjectStore } from "../../../pipeline/store/sqlite.js";
import { StageFailedClosedError } from "../../../runtime/errors.js";
import type { StageContext } from "../../../pipeline/types.js";
import { createServer } from "../../../server/app.js";
import { assert, SequenceProvider } from "./common.js";

export function verifyCsvDirectoryResolve(): void {
  // Safe relative subdirectory under <opsDataDir>/acme
  const safe = resolveClientDataDir("acme", "subdir");
  assert(safe === path.resolve(config.opsDataDir, "acme", "subdir"), `Expected resolved safe path to match, got: ${safe}`);

  // Safe empty/default path resolves to <opsDataDir>/acme
  const def = resolveClientDataDir("acme");
  assert(def === path.resolve(config.opsDataDir, "acme"), `Expected resolved default path to match, got: ${def}`);

  // Path traversal attempt should throw an error
  const unsafePaths = [
    "../../etc",
    "../",
    "../../",
    "/absolute/path",
    "C:\\Windows",
  ];
  for (const p of unsafePaths) {
    let threw = false;
    try {
      resolveClientDataDir("acme", p);
    } catch {
      threw = true;
    }
    assert(threw, `resolveClientDataDir did not throw for unsafe path: ${p}`);
  }
}

export async function verifyOpsDeliveryHonest(): Promise<void> {
  const project = createProject({
    clientId: "eval",
    title: "t",
    definition: opsReportingDefinition,
  });
  const composeStage = project.stages["compose"];
  assert(composeStage, "Compose stage missing.");
  composeStage.artifacts.push({
    stage: "compose",
    kind: "ops_report",
    title: "r",
    content: "# r",
    version: 1,
    createdAt: new Date().toISOString(),
  });

  const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "deliver");
  assert(stageDefinition, "Deliver stage definition missing.");
  const audit = new AuditLogger(project.id, config.auditDir);
  const ctx: StageContext = {
    project,
    stageId: "deliver",
    stageDefinition,
    audit,
    provider: new SequenceProvider([]),
    io: { say: () => undefined, ask: async () => "" },
    store: new JsonProjectStore(),
  };

  const artifacts = await runOpsDeliver(ctx);
  assert(artifacts.length === 1, "Expected 1 artifact from runOpsDeliver");
  const receipt = artifacts[0]!;
  assert(receipt.kind === "delivery_receipt", "Expected delivery_receipt artifact");
  assert(receipt.title === "Delivery Receipt (not sent)", "Expected title 'Delivery Receipt (not sent)'");

  const parsed = JSON.parse(receipt.content);
  assert(parsed.status === "not_sent", `Expected status === "not_sent", got ${parsed.status}`);
  assert(parsed.channel === "none", `Expected channel === "none", got ${parsed.channel}`);
  assert(Array.isArray(parsed.recipients) && parsed.recipients.length === 0, "Expected empty recipients array");
  assert(!receipt.content.includes("@"), "Delivery receipt content must not contain email addresses");
}

export async function verifyOpsNoSilentSynthetic(): Promise<void> {
  assert(syntheticDataAllowed("gemini", false) === false, "gemini without opt-in should be false");
  assert(syntheticDataAllowed("openai-compatible", false) === false, "openai-compatible without opt-in should be false");
  assert(syntheticDataAllowed("gemini", true) === true, "gemini with opt-in should be true");

  const project = createProject({
    clientId: "eval",
    title: "t",
    definition: opsReportingDefinition,
  });
  const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "ingest");
  assert(stageDefinition, "Ingest stage definition missing.");

  class MockAuditLogger extends AuditLogger {
    readonly records: Array<{ type: string; data: Record<string, unknown> }> = [];
    override record(type: any, data: Record<string, unknown>): void {
      this.records.push({ type, data });
      super.record(type, data);
    }
  }

  const prevOptIn = config.opsAllowSynthetic;
  try {
    (config as any).opsAllowSynthetic = true;

    const audit = new MockAuditLogger(project.id, config.auditDir);
    const ctx: StageContext = {
      project,
      stageId: "ingest",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store: new JsonProjectStore(),
    };

    const artifacts = await runOpsIngest(ctx);
    const quality = artifacts.find((a) => a.kind === "data_quality_report");
    assert(quality, "Expected data_quality_report artifact");
    assert(quality.title === "Data Quality Report (SYNTHETIC DEMO DATA)", "Expected synthetic title");

    const parsed = JSON.parse(quality.content);
    assert(parsed.dataOrigin === "synthetic", `Expected dataOrigin === "synthetic", got ${parsed.dataOrigin}`);

    const blockRecord = audit.records.find((r) => r.type === "guardrail_block");
    assert(blockRecord, "Expected guardrail_block audit record");
    const flags = blockRecord.data.flags as string[] | undefined;
    assert(Array.isArray(flags) && flags.includes("synthetic_data"), "Expected synthetic_data flag in audit");
  } finally {
    (config as any).opsAllowSynthetic = prevOptIn;
  }
}

export async function verifyOpsCredentialIsolationAndDecryption(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "jantra-ops-reg-"));
  const sqlitePath = path.join(dir, "jantra.sqlite");
  const origSecretsKey = config.secretsKey;
  try {
    (config as any).secretsKey = "test-secrets-key-32-chars-long!!";
    const store = new SqliteProjectStore(sqlitePath, { skipImport: true });

    // Store credentials for client-a
    store.setConnectorCredentials("client-a", "stripe", { STRIPE_API_KEY: "sk_test_client_a" });
    // Store credentials for client-b
    store.setConnectorCredentials("client-b", "stripe", { STRIPE_API_KEY: "sk_test_client_b" });

    // Isolation check
    const credsA = store.getConnectorCredentials("client-a", "stripe");
    const credsB = store.getConnectorCredentials("client-b", "stripe");
    assert(credsA?.STRIPE_API_KEY === "sk_test_client_a", "client-a credentials must match");
    assert(credsB?.STRIPE_API_KEY === "sk_test_client_b", "client-b credentials must match");
    assert(store.getConnectorCredentials("client-a", "shopify") === null, "unconfigured connector must return null");

    // Decryption failure check: corrupt key and verify runOpsIngest fails closed
    (config as any).secretsKey = "different-key-causes-failure-now!!";
    const project = createProject({
      clientId: "client-a",
      title: "Ops Ingest Failure Test",
      definition: opsReportingDefinition,
    });
    const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "ingest")!;
    const audit = new AuditLogger(project.id, config.auditDir);
    const ctx: StageContext = {
      project,
      stageId: "ingest",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store,
    };

    let threwStageFailedClosed = false;
    try {
      await runOpsIngest(ctx);
    } catch (err: any) {
      if (err instanceof StageFailedClosedError && err.message.includes("Failed to decrypt credentials")) {
        threwStageFailedClosed = true;
      }
    }
    assert(threwStageFailedClosed, "runOpsIngest must fail closed on credential decryption failure");

    store.close();
  } finally {
    (config as any).secretsKey = origSecretsKey;
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyOpsWebhookDelivery(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "jantra-ops-deliv-"));
  const sqlitePath = path.join(dir, "jantra.sqlite");
  const origSecretsKey = config.secretsKey;
  let store: SqliteProjectStore | null = null;
  try {
    (config as any).secretsKey = "test-secrets-key-32-chars-long!!";
    store = new SqliteProjectStore(sqlitePath, { skipImport: true });
    const project = createProject({
      clientId: "client-deliv-reg",
      title: "Ops Delivery Test",
      definition: opsReportingDefinition,
    });

    const composeStage = project.stages["compose"]!;
    composeStage.artifacts.push({
      stage: "compose",
      kind: "ops_report",
      title: "Operations Report",
      content: "# Operations Summary",
      version: 1,
      createdAt: new Date().toISOString(),
    });

    const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "deliver")!;
    const audit = new AuditLogger(project.id, config.auditDir);

    // 1. Success case
    store.setConnectorCredentials("client-deliv-reg", "report-webhook", {
      url: "https://example.com/api/webhook",
      secret: "secret-hmac-123",
    });
    store.setOpsProfile({
      clientId: "client-deliv-reg",
      businessName: "Delivery Corp",
      kpiSpec: { kpis: [] },
      binding: { connectors: [], overlapRules: [] },
      delivery: {
        channel: "webhook",
        credentialRef: "report-webhook",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let mockCalledWithHeaders: any = null;
    const mockSuccessFetch = async (_url: string, init: any) => {
      mockCalledWithHeaders = init.headers;
      return new Response(JSON.stringify({ ok: true, id: "ack_test" }), {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
      });
    };

    const ctxSuccess: StageContext = {
      project,
      stageId: "deliver",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store,
    };
    (ctxSuccess as any).fetchFn = mockSuccessFetch;

    const successReceipts = await runOpsDeliver(ctxSuccess);
    assert(successReceipts.length === 1, "Expected 1 receipt");
    const successReceipt = successReceipts[0]!;
    assert(successReceipt.title === "Delivery Receipt", "Expected 'Delivery Receipt'");
    const parsedSuccess = JSON.parse(successReceipt.content);
    assert(parsedSuccess.status === "sent", "status must be sent");
    assert(parsedSuccess.channel === "webhook", "channel must be webhook");
    assert(parsedSuccess.destinationHost === "example.com", "destinationHost must be example.com");
    assert(parsedSuccess.credentialRef === "report-webhook", "credentialRef must be report-webhook");
    assert(parsedSuccess.url === undefined, "raw URL must not appear in receipt");
    assert(parsedSuccess.recipients === undefined, "recipients must not appear in receipt");
    assert(parsedSuccess.statusCode === 200, "statusCode must be 200");
    assert(Boolean(mockCalledWithHeaders?.["X-Jantra-Signature"]), "HMAC signature must be present");

    // 2. Failure case
    const mockFailFetch = async () => {
      return new Response("Receiver service unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    };
    const ctxFail: StageContext = {
      project,
      stageId: "deliver",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store,
    };
    (ctxFail as any).fetchFn = mockFailFetch;

    const failReceipts = await runOpsDeliver(ctxFail);
    assert(failReceipts.length === 1, "Expected 1 receipt");
    const failReceipt = failReceipts[0]!;
    assert(failReceipt.title === "Delivery Receipt (failed)", "Expected 'Delivery Receipt (failed)'");
    const parsedFail = JSON.parse(failReceipt.content);
    assert(parsedFail.status === "failed", "status must be failed");
    assert(parsedFail.status !== "sent", "failed delivery must NEVER be marked as sent");
    assert(parsedFail.statusCode === 503, "statusCode must be 503");
    assert(parsedFail.errorCode === "http_5xx", "errorCode must be http_5xx");
    assert(parsedFail.destinationHost === "example.com", "destinationHost must be example.com");
    assert(parsedFail.url === undefined, "raw URL must not appear in receipt");

  } finally {
    (config as any).secretsKey = origSecretsKey;
    try { store?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyNoSecretsInResponsesOrDisk(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "jantra-ops-secrets-reg-"));
  const sqlitePath = path.join(dir, "jantra.sqlite");
  const origSecretsKey = config.secretsKey;
  try {
    (config as any).secretsKey = "test-secrets-key-32-chars-long!!";
    const store = new SqliteProjectStore(sqlitePath, { skipImport: true });
    const adminToken = "adm_test_token_super_secret_val";

    const app = createServer({
      mode: "remote",
      loopbackToken: "",
      adminToken,
      store,
      apiKeyStore: store,
      apiKeys: [
        { key: "key_alpha", clientId: "tenant-alpha", subject: "user-alpha" },
        { key: "key_beta", clientId: "tenant-beta", subject: "user-beta" },
      ],
    });

    const secretStripe = "sk_live_very_secret_stripe_12345";
    const webhookSecret = "whsec_super_secret_webhook_99999";
    const webhookUrl = "https://hooks.slack.com/services/T123/B456/SECRETKEY";

    // 1. Admin sets Stripe credential
    const putStripe = await app.inject({
      method: "PUT",
      url: "/v1/admin/clients/tenant-alpha/credentials/stripe",
      headers: { "x-jantra-admin-token": adminToken, "Content-Type": "application/json" },
      payload: { credentials: { STRIPE_API_KEY: secretStripe } },
    });
    assert(putStripe.statusCode === 200, "Admin PUT credential must succeed");
    assert(!JSON.stringify(putStripe.json()).includes(secretStripe), "PUT response must not leak secret");

    // 2. Admin sets report-webhook credential
    const putWebhook = await app.inject({
      method: "PUT",
      url: "/v1/admin/clients/tenant-alpha/credentials/report-webhook",
      headers: { "x-jantra-admin-token": adminToken, "Content-Type": "application/json" },
      payload: { credentials: { url: webhookUrl, secret: webhookSecret } },
    });
    assert(putWebhook.statusCode === 200, "Admin PUT report-webhook credential must succeed");
    assert(!JSON.stringify(putWebhook.json()).includes(webhookSecret), "PUT webhook response must not leak secret");

    // 3. Admin GET credentials returns metadata only, never secret strings
    const getAdminStripe = await app.inject({
      method: "GET",
      url: "/v1/admin/clients/tenant-alpha/credentials/stripe",
      headers: { "x-jantra-admin-token": adminToken },
    });
    assert(getAdminStripe.statusCode === 200, "Admin GET stripe must succeed");
    const adminStripeJson = getAdminStripe.json();
    assert(adminStripeJson.configured === true, "configured must be true");
    assert(!JSON.stringify(adminStripeJson).includes(secretStripe), "Admin GET must not return secret");

    const getAdminWebhook = await app.inject({
      method: "GET",
      url: "/v1/admin/clients/tenant-alpha/credentials/report-webhook",
      headers: { "x-jantra-admin-token": adminToken },
    });
    assert(getAdminWebhook.statusCode === 200, "Admin GET report-webhook must succeed");
    const adminWebhookJson = getAdminWebhook.json();
    assert(adminWebhookJson.configured === true, "configured must be true");
    assert(!JSON.stringify(adminWebhookJson).includes(webhookSecret), "Admin GET webhook must not return secret");
    assert(!JSON.stringify(adminWebhookJson).includes("SECRETKEY"), "Admin GET webhook must not return URL path secret");

    // 4. Tenant routes cannot manage or read raw credentials (returns 403)
    const tenantPut = await app.inject({
      method: "PUT",
      url: "/v1/credentials/stripe",
      headers: { Authorization: "Bearer key_alpha", "Content-Type": "application/json" },
      payload: { credentials: { STRIPE_API_KEY: "hack" } },
    });
    assert(tenantPut.statusCode === 403, "Tenant PUT credentials must be 403");

    const tenantGet = await app.inject({
      method: "GET",
      url: "/v1/credentials/stripe",
      headers: { Authorization: "Bearer key_alpha" },
    });
    assert(tenantGet.statusCode === 403, "Tenant GET credentials/:connector must be 403");

    // 5. Tenant GET /v1/credentials lists only configured connector ids
    const tenantList = await app.inject({
      method: "GET",
      url: "/v1/credentials",
      headers: { Authorization: "Bearer key_alpha" },
    });
    assert(tenantList.statusCode === 200, "Tenant list must be 200");
    const tenantListJson = tenantList.json();
    assert(tenantListJson.connectors.includes("stripe"), "should include stripe");
    assert(tenantListJson.connectors.includes("report-webhook"), "should include report-webhook");
    assert(!JSON.stringify(tenantListJson).includes(secretStripe), "list must not leak secret");

    // Tenant-beta sees nothing from tenant-alpha
    const tenantBetaList = await app.inject({
      method: "GET",
      url: "/v1/credentials",
      headers: { Authorization: "Bearer key_beta" },
    });
    assert(tenantBetaList.statusCode === 200, "tenant-beta status must be 200");
    assert(tenantBetaList.json().connectors.length === 0, "tenant-beta must have no connectors");

    // 6. Verify SQLite storage on disk does not contain plaintext secrets
    const sqliteBytes = readFileSync(sqlitePath, "utf8");
    assert(!sqliteBytes.includes(secretStripe), "SQLite must not contain stripe secret in plaintext");
    assert(!sqliteBytes.includes(webhookSecret), "SQLite must not contain webhook secret in plaintext");

    await app.close();
    store.close();
  } finally {
    (config as any).secretsKey = origSecretsKey;
    rmSync(dir, { recursive: true, force: true });
  }
}

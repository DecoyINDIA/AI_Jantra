import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { createProject } from "../orchestrator.js";
import { opsReportingDefinition } from "../../agents/opsReporting.js";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import { JsonProjectStore } from "../store.js";
import type { StageContext } from "../types.js";
import { SequenceProvider } from "../../runtime/evals/regressions/common.js";
import { StageFailedClosedError } from "../../runtime/errors.js";
import { deliverReportWebhook, runOpsDeliver } from "./opsReporting.js";

describe("Lekha Ops Report Delivery Layer (T-019)", () => {
  const originalSecretsKey = config.secretsKey;
  it("delivers signed webhook, records provider response, timestamp, and status sent", async () => {
    let receivedPayload: any = null;
    let receivedSignature: string | null = null;
    let receivedEvent: string | null = null;

    const server = http.createServer(async (req, res) => {
      receivedSignature = req.headers["x-jantra-signature"] as string || null;
      receivedEvent = req.headers["x-jantra-event"] as string || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      receivedPayload = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messageId: "msg_12345_ok", status: "delivered" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook/reports`;
    const secret = "test-webhook-secret-xyz";

    try {
      const outcome = await deliverReportWebhook(
        webhookUrl,
        secret,
        {
          id: "deliv_1",
          clientId: "client_test",
          projectId: "proj_test",
          report: { title: "Operations Report", content: "# Facts" },
        },
        1,
        (url, init) => fetch(url, init as any),
      );

      assert.equal(outcome.ok, true);
      assert.equal(outcome.statusCode, 200);

      assert.ok(receivedPayload);
      assert.equal(receivedPayload.clientId, "client_test");
      assert.equal(receivedEvent, "ops.report_delivered");

      // Verify HMAC signature
      const expectedSig = createHmac("sha256", secret)
        .update(JSON.stringify(receivedPayload))
        .digest("hex");
      assert.equal(receivedSignature, expectedSig);
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      server.close();
    }
  });

  it("NEVER marks delivery as sent when endpoint returns an error (status failed)", async () => {
    let callCount = 0;
    const server = http.createServer((req, res) => {
      callCount++;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error at receiver");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook/reports`;

    try {
      const outcome = await deliverReportWebhook(
        webhookUrl,
        "test-secret",
        { id: "deliv_fail", report: { title: "Report", content: "data" } },
        2,
        (url, init) => fetch(url, init as any),
      );

      assert.equal(outcome.ok, false);
      assert.equal(outcome.statusCode, 500);
      assert.equal(outcome.errorCode, "http_5xx");
      assert.ok(callCount >= 2, "Should have retried transient 500 error");
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      server.close();
    }
  });

  it("stops immediately without retry on non-retryable 4xx client errors", async () => {
    let callCount = 0;
    const server = http.createServer((req, res) => {
      callCount++;
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook/reports`;

    try {
      const outcome = await deliverReportWebhook(
        webhookUrl,
        "test-secret",
        { id: "deliv_401" },
        3,
        (url, init) => fetch(url, init as any),
      );

      assert.equal(outcome.ok, false);
      assert.equal(outcome.statusCode, 401);
      assert.equal(outcome.errorCode, "http_4xx");
      assert.equal(callCount, 1, "Should NOT retry non-retryable 401 error");
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      server.close();
    }
  });

  it("runOpsDeliver produces sent delivery_receipt when webhook succeeds", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ acknowledged: true, id: "ack_999" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook/ops`;

    try {
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";
      const project = createProject({
        clientId: "client-delivery-test",
        title: "Ops Run",
        definition: opsReportingDefinition,
      });

      const composeStage = project.stages["compose"]!;
      composeStage.artifacts.push({
        stage: "compose",
        kind: "ops_report",
        title: "Operations Report",
        content: "# Operations Summary\nRevenue was 5000.",
        version: 1,
        createdAt: new Date().toISOString(),
      });

      const stageDefinition = project.agentDefinitionSnapshot.stages.find((s) => s.id === "deliver")!;
      const store = new JsonProjectStore();

      // Configure report-webhook credential and reporting profile in store
      store.setConnectorCredentials("client-delivery-test", "report-webhook", {
        url: webhookUrl,
        secret: "secret-key-123",
      });
      store.setOpsProfile({
        clientId: "client-delivery-test",
        businessName: "Test Business",
        kpiSpec: { kpis: [] },
        binding: { connectors: [], overlapRules: [] },
        delivery: {
          channel: "webhook",
          credentialRef: "report-webhook",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      class MockAuditLogger extends AuditLogger {
        readonly records: Array<{ type: string; data: Record<string, unknown> }> = [];
        override record(type: any, data: Record<string, unknown>): void {
          this.records.push({ type, data });
          super.record(type, data);
        }
      }

      const audit = new MockAuditLogger(project.id, config.auditDir);
      const ctx: StageContext = {
        project,
        stageId: "deliver",
        stageDefinition,
        audit,
        provider: new SequenceProvider([]),
        io: { say: () => undefined, ask: async () => "" },
        store,
      };
      (ctx as any).fetchFn = (url: string, init: any) => fetch(url, init);

      const artifacts = await runOpsDeliver(ctx);
      assert.equal(artifacts.length, 1);
      const receipt = artifacts[0]!;
      assert.equal(receipt.kind, "delivery_receipt");
      assert.equal(receipt.title, "Delivery Receipt");

      const parsed = JSON.parse(receipt.content);
      assert.equal(parsed.status, "sent");
      assert.equal(parsed.channel, "webhook");
      assert.equal(parsed.destinationHost, "127.0.0.1");
      assert.equal(parsed.credentialRef, "report-webhook");
      assert.equal(parsed.url, undefined);
      assert.equal(parsed.recipients, undefined);
      assert.ok(parsed.timestamp);
      assert.ok(parsed.artifactHash.startsWith("sha256-"));
      assert.equal(parsed.statusCode, 200);

      // Check audit: destinationHost only, no raw URL
      const auditEntry = audit.records.find((r) => r.type === "report_delivered");
      assert.ok(auditEntry);
      assert.equal(auditEntry.data.status, "sent");
      assert.equal(auditEntry.data.statusCode, 200);
      assert.equal(auditEntry.data.destinationHost, "127.0.0.1");
      assert.equal((auditEntry.data as any).url, undefined);
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      server.close();
    }
  });

  it("runOpsDeliver produces failed delivery_receipt when webhook returns 500 error", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook/ops-fail`;

    try {
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";
      const project = createProject({
        clientId: "client-delivery-fail",
        title: "Ops Run",
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
      const store = new JsonProjectStore();

      // Configure report-webhook credential and reporting profile
      store.setConnectorCredentials("client-delivery-fail", "report-webhook", {
        url: webhookUrl,
        secret: "secret-key-123",
      });
      store.setOpsProfile({
        clientId: "client-delivery-fail",
        businessName: "Test Business",
        kpiSpec: { kpis: [] },
        binding: { connectors: [], overlapRules: [] },
        delivery: {
          channel: "webhook",
          credentialRef: "report-webhook",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      class MockAuditLogger extends AuditLogger {
        readonly records: Array<{ type: string; data: Record<string, unknown> }> = [];
        override record(type: any, data: Record<string, unknown>): void {
          this.records.push({ type, data });
          super.record(type, data);
        }
      }

      const audit = new MockAuditLogger(project.id, config.auditDir);
      const ctx: StageContext = {
        project,
        stageId: "deliver",
        stageDefinition,
        audit,
        provider: new SequenceProvider([]),
        io: { say: () => undefined, ask: async () => "" },
        store,
      };
      (ctx as any).fetchFn = (url: string, init: any) => fetch(url, init);

      const artifacts = await runOpsDeliver(ctx);
      assert.equal(artifacts.length, 1);
      const receipt = artifacts[0]!;
      assert.equal(receipt.kind, "delivery_receipt");
      assert.equal(receipt.title, "Delivery Receipt (failed)");

      const parsed = JSON.parse(receipt.content);
      assert.equal(parsed.status, "failed");
      assert.notEqual(parsed.status, "sent");
      assert.equal(parsed.channel, "webhook");
      assert.equal(parsed.destinationHost, "127.0.0.1");
      assert.equal(parsed.credentialRef, "report-webhook");
      assert.equal(parsed.url, undefined);
      assert.equal(parsed.recipients, undefined);
      assert.equal(parsed.statusCode, 502);
      assert.equal(parsed.errorCode, "http_5xx");

      const auditEntry = audit.records.find((r) => r.type === "error");
      assert.ok(auditEntry);
      assert.equal(auditEntry.data.status, "failed");
      assert.equal(auditEntry.data.destinationHost, "127.0.0.1");
      assert.equal(auditEntry.data.credentialRef, "report-webhook");
      assert.equal((auditEntry.data as any).url, undefined);
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      server.close();
    }
  });

  it("fails closed when report-webhook credentials are missing or corrupted", async () => {
    const project = createProject({
      clientId: "client-missing-creds",
      title: "Ops Run",
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
    const store = new JsonProjectStore();
    store.setOpsProfile({
      clientId: "client-missing-creds",
      businessName: "Test Business",
      kpiSpec: { kpis: [] },
      binding: { connectors: [], overlapRules: [] },
      delivery: { channel: "webhook", credentialRef: "report-webhook" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const audit = new AuditLogger(project.id, config.auditDir);
    const ctx: StageContext = {
      project,
      stageId: "deliver",
      stageDefinition,
      audit,
      provider: new SequenceProvider([]),
      io: { say: () => undefined, ask: async () => "" },
      store,
    };

    await assert.rejects(
      async () => runOpsDeliver(ctx),
      (err: any) => err instanceof StageFailedClosedError,
    );
  });
});

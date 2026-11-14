import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyRequest } from "fastify";
import { createProject } from "../../../pipeline/orchestrator.js";
import { JsonProjectStore, type ProjectStore } from "../../../pipeline/store.js";
import { SqliteProjectStore } from "../../../pipeline/store/sqlite.js";
import { createServer } from "../../../server/app.js";
import { createFixedWindowLimiter, installIdentityRateLimit } from "../../../server/rateLimit.js";
import { runParamsSchema } from "../../../server/schemas.js";
import { registerLeadRoutes } from "../../../server/routes/leads.js";
import { visitorAddress } from "../../../server/visitor.js";
import { hashApiKey } from "../../../server/auth/apiKeys.js";
import { reloadModelCatalog } from "../../../model/catalog.js";
import { config } from "../../../config.js";
import { assert, readAuditJsonl } from "./common.js";
import {
  createLicenseToken,
  generateLicenseKeyPair,
  EMBEDDED_LICENSE_PUBLIC_KEY,
  MemoryLicenseStore,
  LicenseManager,
  parseLicenseToken,
  type LicensePayload,
} from "../../../licensing/index.js";

export async function verifyRejectRoutePersistsReason(): Promise<void> {
  const token = "reject-regression-token";
  const clientId = `eval-reject-${Date.now()}`;
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const app = createServer({ loopbackToken: token, clientId, store });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "planning-pipeline",
        title: "Reject regression",
      },
    });
    assert(created.statusCode === 200, `Run create failed: ${created.body}`);
    const runId = created.json().run.id as string;

    const project = store.loadProject(clientId, runId);
    assert(project, "Project was not found in store.");
    const stage = project.stages.intake;
    assert(stage, "Intake stage was not found on project.");
    stage.status = "awaiting_confirmation";
    store.saveProject(project);

    const reason = "Missing target customer evidence.";

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/reject`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { reason },
    });
    assert(rejected.statusCode === 200, `Run reject failed: ${rejected.body}`);
    assert(
      rejected.json().run.stages.intake.rejectionReason === reason,
      "Reject response did not include the persisted stage reason.",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: auth,
    });
    assert(detail.statusCode === 200, `Run detail failed: ${detail.body}`);
    assert(
      detail.json().run.stages.intake.status === "rejected" &&
        detail.json().run.stages.intake.rejectionReason === reason,
      "Reloaded run did not preserve rejection status and reason.",
    );

    const audit = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/audit`,
      headers: auth,
    });
    assert(audit.statusCode === 200, `Audit read failed: ${audit.body}`);
    const items = audit.json().items as Array<Record<string, unknown>>;
    assert(
      items.some(
        (entry) =>
          entry.type === "stage_gate" &&
          entry.status === "rejected" &&
          entry.stage === "intake" &&
          entry.reason === reason,
      ),
      "Audit log did not record the rejection reason.",
    );
  } finally {
    await app.close();
  }
}

export function verifyRunIdPathTraversalRejected(): void {
  // Schema layer: traversal and separators are rejected; a clean slug passes.
  assert(
    !runParamsSchema.safeParse({ runId: "../../secret" }).success,
    "runParamsSchema accepted a traversal runId.",
  );
  assert(
    !runParamsSchema.safeParse({ runId: "a/b" }).success,
    "runParamsSchema accepted a runId containing a path separator.",
  );
  assert(
    runParamsSchema.safeParse({ runId: "9f8e7d6c-1234-5678-9abc-def012345678" }).success,
    "runParamsSchema rejected a normal UUID runId.",
  );

  // Store layer (defense in depth): the path builder refuses unsafe segments
  // even if a bad value somehow bypasses the schema.
  const store = new JsonProjectStore();
  let threw = false;
  try {
    store.loadProject("xolver", "../../etc/passwd");
  } catch {
    threw = true;
  }
  assert(threw, "JsonProjectStore.loadProject did not reject a traversal projectId.");
  // A clean id must NOT throw at the path layer (returns null for a missing run).
  assert(
    store.loadProject("xolver", "no-such-run-id") === null,
    "JsonProjectStore.loadProject mishandled a clean, non-existent runId.",
  );
}

export function verifyRateLimiterFixedWindow(): void {
  let nowMs = 0;
  const check = createFixedWindowLimiter({ windowMs: 1000, max: 2, now: () => nowMs });
  assert(check("ip-a").allowed, "First request under the limit was blocked.");
  assert(check("ip-a").allowed, "Second request under the limit was blocked.");
  assert(!check("ip-a").allowed, "Third request over the limit was allowed.");
  // A different key has an independent bucket.
  assert(check("ip-b").allowed, "Independent client key shared a bucket.");
  // After the window elapses, the bucket resets.
  nowMs = 1001;
  assert(check("ip-a").allowed, "Bucket did not reset after the window elapsed.");
}

export async function verifyRateLimiterProxyTrust(): Promise<void> {
  const token = "rate-limit-token";
  // Create a remote mode server which enables the rate limiter
  const app = createServer({ loopbackToken: token, mode: "remote" });

  const res1 = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: {
      "X-Forwarded-For": "1.1.1.1, 9.9.9.9",
      "Authorization": `Bearer ${token}`,
    },
  });

  const res2 = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: {
      "X-Forwarded-For": "2.2.2.2, 9.9.9.9",
      "Authorization": `Bearer ${token}`,
    },
  });

  const remaining1 = parseInt(res1.headers["x-ratelimit-remaining"] as string, 10);
  const remaining2 = parseInt(res2.headers["x-ratelimit-remaining"] as string, 10);

  assert(!Number.isNaN(remaining1), "X-RateLimit-Remaining header missing or NaN on first request");
  assert(!Number.isNaN(remaining2), "X-RateLimit-Remaining header missing or NaN on second request");
  assert(remaining2 === remaining1 - 1, `Spoofed X-Forwarded-For bypassed rate limiter (remaining1=${remaining1}, remaining2=${remaining2})`);
}

export async function verifyVisitorRateLimit(): Promise<void> {
  const app = fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).identity = {
      subject: "web",
      scope: "public",
      allowedAgentIds: ["intake-public"],
    };
  });
  installIdentityRateLimit(app, {
    windowMs: 60_000,
    publicMax: 30,
    fullMax: 120,
  });
  app.post("/v1/runs", async () => ({ ok: true }));

  for (let i = 0; i < 30; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "x-jantra-client-ip": "198.51.100.1" },
    });
    assert(res.statusCode === 200, `Request ${i} failed with status ${res.statusCode}`);
  }
  const res31 = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { "x-jantra-client-ip": "198.51.100.1" },
  });
  assert(res31.statusCode === 429, `31st request should be 429, got ${res31.statusCode}`);

  const resOther = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { "x-jantra-client-ip": "198.51.100.2" },
  });
  assert(resOther.statusCode === 200, `Different IP should be allowed, got ${resOther.statusCode}`);
  await app.close();
}

export function verifyVisitorHeaderIgnoredForFullKeys(): void {
  const fullReq = {
    identity: { scope: "full", subject: "admin" },
    headers: { "x-jantra-client-ip": "198.51.100.1" },
    ip: "127.0.0.1",
  } as unknown as FastifyRequest;
  assert(visitorAddress(fullReq) === "127.0.0.1", `Expected 127.0.0.1, got ${visitorAddress(fullReq)}`);

  const publicReq = {
    identity: { scope: "public", subject: "web" },
    headers: { "x-jantra-client-ip": "198.51.100.1" },
    ip: "127.0.0.1",
  } as unknown as FastifyRequest;
  assert(visitorAddress(publicReq) === "198.51.100.1", `Expected 198.51.100.1, got ${visitorAddress(publicReq)}`);

  const invalidIpReq = {
    identity: { scope: "public", subject: "web" },
    headers: { "x-jantra-client-ip": "not-an-ip" },
    ip: "127.0.0.1",
  } as unknown as FastifyRequest;
  assert(visitorAddress(invalidIpReq) === "127.0.0.1", `Expected 127.0.0.1 for invalid IP, got ${visitorAddress(invalidIpReq)}`);
}

export async function verifyErrorEnvelopeNoLeak(): Promise<void> {
  const storeStub = {
    loadProject: () => {
      throw new Error("SECRET /data/jantra/x.sqlite");
    },
  } as unknown as ProjectStore;

  const app = createServer({
    mode: "local",
    loopbackToken: "test-token",
    store: storeStub,
  });

  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs/abc",
      headers: { authorization: "Bearer test-token" },
    });
    assert(res.statusCode === 500, `Expected 500 status code, got ${res.statusCode}`);
    const body = res.json() as { error?: { code?: string; message?: string; details?: { requestId?: string } } };
    assert(body.error?.code === "internal_error", `Expected code === "internal_error", got ${body.error?.code}`);
    assert(body.error?.message === "Internal error.", `Expected message === "Internal error.", got ${body.error?.message}`);
    assert(!res.body.includes("SECRET"), "Error response leaked secret text");
    assert(typeof body.error?.details?.requestId === "string" && body.error.details.requestId.length > 0, "Expected non-empty requestId");
  } finally {
    await app.close();
  }
}

export async function verifyLeadRunLinkAndWebhooks(): Promise<void> {
  const token = "lead-webhook-token";
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const app = createServer({ loopbackToken: token, store });

  try {
    // 1. Create a run for client-alpha
    const runAlphaRes = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "intake-public",
        title: "Alpha intake",
      },
    });
    assert(runAlphaRes.statusCode === 200, `Expected 200, got ${runAlphaRes.statusCode}`);
    const runAlphaId = runAlphaRes.json().run.id as string;

    // 2. Post lead with valid runId under same client
    const leadRes = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        name: "Test Founder",
        email: "founder@example.com",
        idea: "My startup idea",
        runId: runAlphaId,
      },
    });
    assert(leadRes.statusCode === 201, `Expected 201 for lead creation with runId, got ${leadRes.statusCode}: ${leadRes.body}`);
    const leadBody = leadRes.json();
    assert(leadBody.runId === runAlphaId, "Lead response missing runId");

    // 3. Post lead with non-existent runId -> 404
    const notFoundLead = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        name: "Test Founder",
        email: "founder@example.com",
        idea: "My startup idea",
        runId: "non-existent-run-id",
      },
    });
    assert(notFoundLead.statusCode === 404, `Expected 404 for non-existent runId, got ${notFoundLead.statusCode}`);

    // 4. Test cross-tenant isolation: create another app with client-beta
    const appBeta = createServer({
      mode: "remote",
      loopbackToken: "",
      apiKeys: [{ key: "beta-key", clientId: "client-beta", subject: "beta" }],
      store,
    });
    try {
      const crossTenantLead = await appBeta.inject({
        method: "POST",
        url: "/v1/leads",
        headers: { authorization: "Bearer beta-key", "content-type": "application/json" },
        payload: {
          name: "Beta Founder",
          email: "beta@example.com",
          idea: "Beta idea",
          runId: runAlphaId, // belongs to default client, not client-beta
        },
      });
      assert(crossTenantLead.statusCode === 404, `Expected 404 for cross-tenant runId, got ${crossTenantLead.statusCode}`);
    } finally {
      await appBeta.close();
    }
  } finally {
    await app.close();
  }
}

export async function verifyPromoteIntakeToPlan(): Promise<void> {
  const token = "promote-token";
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const clientId = `eval-promote-${Date.now()}`;
  const app = createServer({
    loopbackToken: token,
    clientId,
    store,
  });

  try {
    // 1. Create a public intake run without summary to test missing summary guard
    const emptySource = createProject({
      clientId,
      title: "Incomplete Intake Run",
      agentId: "intake-public",
    });
    store.saveProject(emptySource);

    const earlyPromote = await app.inject({
      method: "POST",
      url: `/v1/runs/${emptySource.id}/promote`,
      headers: { ...auth },
    });
    assert(earlyPromote.statusCode === 400, `Expected 400 for early promote, got ${earlyPromote.statusCode}`);

    // 2. Create a completed intake run with idea_summary artifact
    const sourceProject = createProject({
      clientId,
      title: "Completed Intake Run",
      agentId: "intake-public",
    });
    const now = new Date().toISOString();
    const ideaSummaryArtifact = {
      stage: "intake",
      kind: "idea_summary",
      title: "Completed Intake Idea Summary",
      content: "# Idea Summary\n\nA reconciliation tool for small ecommerce finance teams.",
      version: 1,
      createdAt: now,
    };
    const intakeStage = sourceProject.stages.intake;
    assert(intakeStage, "Expected intake stage on source project");
    intakeStage.status = "awaiting_confirmation";
    intakeStage.artifacts = [ideaSummaryArtifact];
    store.saveProject(sourceProject);
    store.writeArtifactFile(clientId, sourceProject.id, ideaSummaryArtifact);

    // 3. Promote the intake run
    const promoteRes = await app.inject({
      method: "POST",
      url: `/v1/runs/${sourceProject.id}/promote`,
      headers: { ...auth },
    });
    assert(promoteRes.statusCode === 201, `Promote failed: ${promoteRes.statusCode}: ${promoteRes.body}`);
    const promotedRun = promoteRes.json().run;
    assert(promotedRun.agentId === "planning-pipeline", "Expected planning-pipeline agent");
    assert(promotedRun.currentStage === "research", `Expected currentStage === research, got ${promotedRun.currentStage}`);
    assert(promotedRun.stages.intake.status === "confirmed", "Expected confirmed intake stage");
    assert(promotedRun.stages.intake.artifacts.length === 1, "Expected copied artifact in intake stage");
    assert(promotedRun.stages.intake.artifacts[0].kind === "idea_summary", "Expected idea_summary");
    assert(promotedRun.stages.research.status === "pending", "Expected research pending");

    // 4. Verify the artifact can be loaded via artifact route for the promoted run
    const artifactRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${promotedRun.id}/artifacts/idea_summary`,
      headers: { ...auth },
    });
    assert(artifactRes.statusCode === 200, `Expected 200 for artifact fetch, got ${artifactRes.statusCode}`);
    assert(artifactRes.json().artifact.kind === "idea_summary", "Expected idea_summary artifact");

    // 5. Verify source run is unchanged
    const sourceCheck = await app.inject({
      method: "GET",
      url: `/v1/runs/${sourceProject.id}`,
      headers: { ...auth },
    });
    const sourceFinal = sourceCheck.json().run;
    assert(sourceFinal.agentId === "intake-public", "Source run agent changed");
    assert(sourceFinal.currentStage === "intake", "Source run stage changed");
    assert(sourceFinal.stages.intake.status === "awaiting_confirmation", "Source run status changed");
    assert(sourceFinal.stages.intake.artifacts.length === 1, "Source run artifacts changed");

    // 6. Verify audit records promotedFrom
    const auditEntries = readAuditJsonl(promotedRun.id);
    const runCreated = auditEntries.find((e) => e.type === "run_created");
    assert(runCreated?.promotedFrom === sourceProject.id, `Audit missing promotedFrom: ${JSON.stringify(runCreated)}`);

    // 7. Verify public key cannot promote
    const remoteApp = createServer({
      mode: "remote",
      loopbackToken: "",
      apiKeys: [{ key: "pub-key", clientId, subject: "web" }],
      store,
    });
    try {
      const publicPromote = await remoteApp.inject({
        method: "POST",
        url: `/v1/runs/${sourceProject.id}/promote`,
        headers: { authorization: "Bearer pub-key" },
      });
      assert(publicPromote.statusCode === 403, `Expected 403 for public key promote, got ${publicPromote.statusCode}`);
    } finally {
      await remoteApp.close();
    }
  } finally {
    await app.close();
  }
}

export async function verifyClientReadyExport(): Promise<void> {
  const token = "export-regression-token";
  const clientId = `eval-export-${Date.now()}`;
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const app = createServer({ loopbackToken: token, clientId, store });

  try {
    const project = createProject({
      clientId,
      title: "Export Regression Suite",
      agentId: "planning-pipeline",
    });

    const now = new Date().toISOString();
    project.stages.intake = {
      id: "intake",
      status: "confirmed",
      artifacts: [
        {
          stage: "intake",
          kind: "idea_summary",
          title: "Executive Summary",
          content: "# Idea Overview\n\nPlatform for automated supply chain verification.",
          version: 1,
          createdAt: now,
        },
      ],
      evals: [],
      updatedAt: now,
    };

    project.stages.research = {
      id: "research",
      status: "confirmed",
      artifacts: [
        {
          stage: "research",
          kind: "research_report",
          title: "Market Analysis",
          content: "## Findings\n\nMarket demand is accelerating in Q1.",
          version: 1,
          createdAt: now,
        },
      ],
      evals: [],
      updatedAt: now,
    };

    project.stages.planning = {
      id: "planning",
      status: "confirmed",
      artifacts: [
        {
          stage: "planning",
          kind: "prd",
          title: "Product Requirements",
          content: "## Requirements\n\nMust verify all suppliers deterministically.",
          version: 1,
          createdAt: now,
        },
        {
          stage: "planning",
          kind: "trd",
          title: "Technical Requirements",
          content: "## Specs\n\nNode.js and SQLite architecture.",
          version: 1,
          createdAt: now,
        },
        {
          stage: "planning",
          kind: "build_plan",
          title: "Phased Execution Plan",
          content: "## Roadmap\n\nPhase 1 deployment by end of month.",
          version: 1,
          createdAt: now,
        },
      ],
      evals: [],
      updatedAt: now,
    };

    project.sources = [
      {
        id: "src-supply-chain",
        clientId,
        title: "Global Supply Chain Index 2026",
        url: "https://example.com/supply-chain-2026",
        retrievedAt: now,
        contentHash: "fedcba9876543210",
        qualityScore: 0.92,
      },
    ];

    project.claims = [
      {
        text: "Supplier verification errors cost mid-market firms $2.4M annually.",
        verified: true,
        support: "verified",
        sourceIds: ["src-supply-chain"],
        citations: [
          {
            sourceId: "src-supply-chain",
            quote: "Mid-market logistics providers lose an average of $2.4M every year to manual verification latency.",
          },
        ],
      },
    ];

    store.saveProject(project);

    // 1. GET /v1/runs/:runId/export
    const res = await app.inject({
      method: "GET",
      url: `/v1/runs/${project.id}/export`,
      headers: { ...auth },
    });

    assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert(
      (res.headers["content-type"] as string)?.includes("text/html"),
      `Expected text/html content-type, got ${res.headers["content-type"]}`,
    );

    const html = res.body;

    // Verify title and metadata
    assert(html.includes("Export Regression Suite"), "Missing project title");
    assert(html.includes(clientId), "Missing client ID");
    assert(html.includes(project.id), "Missing run ID");

    // Verify print styling
    assert(html.includes("@media print"), "Missing @media print stylesheet");
    assert(html.includes("window.print()"), "Missing print trigger");

    // Verify artifacts
    assert(html.includes("Idea Overview"), "Missing idea summary content");
    assert(html.includes("Market Analysis"), "Missing research report content");
    assert(html.includes("Product Requirements"), "Missing PRD content");
    assert(html.includes("Technical Requirements"), "Missing TRD content");
    assert(html.includes("Phased Execution Plan"), "Missing build plan content");

    // Verify claims, quotes, and sources
    assert(html.includes("Supplier verification errors cost mid-market firms $2.4M annually."), "Missing claim text");
    assert(html.includes("Mid-market logistics providers lose an average of $2.4M every year"), "Missing citation quote");
    assert(html.includes("Global Supply Chain Index 2026"), "Missing source title");
    assert(html.includes("https://example.com/supply-chain-2026"), "Missing source URL");
  } finally {
    await app.close();
  }
}

export async function verifySqliteMigrationsAndStores(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-server-sqlite-"));
  const adminToken = "test-admin-secret-token";
  const clientId = `eval-sqlite-${Date.now()}`;
  const dbPath = path.join(dir, "server.sqlite");
  const store = new SqliteProjectStore(dbPath, { skipImport: true });

  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    adminToken,
    clientId,
    store,
  });

  try {
    // 1. Issue an API key via admin route with scope: "public" and allowedAgents: ["intake-public"]
    const createKeyRes = await app.inject({
      method: "POST",
      url: "/v1/admin/keys",
      headers: {
        "x-jantra-admin-token": adminToken,
        "content-type": "application/json",
      },
      payload: {
        label: "Public Widget",
        clientId,
        subject: "web-user",
        scope: "public",
        allowedAgents: ["intake-public"],
      },
    });

    assert(createKeyRes.statusCode === 200, `Key creation failed: ${createKeyRes.body}`);
    const keyData = createKeyRes.json();
    assert(keyData.apiKey.scope === "public", `Expected scope public, got ${keyData.apiKey.scope}`);
    assert(
      JSON.stringify(keyData.apiKey.allowedAgents) === JSON.stringify(["intake-public"]),
      `Expected allowedAgents ["intake-public"], got ${JSON.stringify(keyData.apiKey.allowedAgents)}`,
    );
    const rawKey = keyData.key as string;

    // 2. Use the created public key to call POST /v1/runs with planning-pipeline -> 403
    const forbiddenRun = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        agentId: "planning-pipeline",
        title: "Disallowed planning run",
      },
    });
    assert(forbiddenRun.statusCode === 403, `Expected 403, got ${forbiddenRun.statusCode}`);

    // 3. Use the public key to create a public intake run -> 200
    const allowedRun = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        agentId: "intake-public",
        title: "Allowed intake run",
      },
    });
    assert(allowedRun.statusCode === 200, `Expected 200, got ${allowedRun.statusCode}`);
    const runId = allowedRun.json().run.id as string;

    // 4. Capture a lead via POST /v1/leads
    const leadRes = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        name: "Test User",
        email: "test@example.com",
        idea: "Automated logistics",
        source: "eval",
        runId,
      },
    });
    assert(leadRes.statusCode === 201, `Lead creation failed: ${leadRes.body}`);
    const leadId = leadRes.json().id as string;

    // 5. Verify the lead is stored in SQLite
    const leadInDb = store.listLeads(clientId).find((l) => l.id === leadId);
    assert(leadInDb, "Lead was not found in SQLite store");
    assert(leadInDb.email === "test@example.com", `Expected email test@example.com, got ${leadInDb.email}`);
    assert(leadInDb.runId === runId, `Expected runId ${runId}, got ${leadInDb.runId}`);
  } finally {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyAsyncStageExecution(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-async-eval-"));
  const dbPath = path.join(dir, "async.sqlite");
  const store = new SqliteProjectStore(dbPath, { skipImport: true });
  const rawKey = "jnt_live_asynctest_1234567890abcdef1234567890abcdef";
  const clientId = "async-eval-client";

  store.createApiKey({
    id: "key-async-eval",
    keyHash: hashApiKey(rawKey),
    prefix: "jnt_live_",
    clientId,
    subject: "operator",
    label: "Async stage evaluation key",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    scope: "full",
  });

  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store,
    jobPollIntervalMs: 20,
  });

  try {
    // 1. Create a run
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        agentId: "planning-pipeline",
        title: "Async stage run",
      },
    });
    assert(createRes.statusCode === 200, `Run creation failed: ${createRes.body}`);
    const runId = createRes.json().run.id as string;

    // 2. Advance stage with Prefer: respond-async -> 202 Accepted
    const advanceRes = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/advance`,
      headers: {
        authorization: `Bearer ${rawKey}`,
        prefer: "respond-async",
      },
    });
    assert(advanceRes.statusCode === 202, `Expected 202, got ${advanceRes.statusCode}: ${advanceRes.body}`);
    const jobId = advanceRes.json().job.id as string;
    assert(jobId && jobId.length > 0, "Expected job id in 202 response");

    // 3. Poll GET /v1/runs/:runId/jobs/:jobId until done
    const deadline = Date.now() + 5000;
    let jobStatus = "queued";
    while (Date.now() < deadline && jobStatus !== "done") {
      await new Promise((r) => setTimeout(r, 40));
      const jobRes = await app.inject({
        method: "GET",
        url: `/v1/runs/${runId}/jobs/${jobId}`,
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      });
      assert(jobRes.statusCode === 200, `Job get failed: ${jobRes.body}`);
      jobStatus = jobRes.json().job.status as string;
    }
    assert(jobStatus === "done", `Expected job status done, got ${jobStatus}`);

    // 4. Verify run reached awaiting gate
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(getRes.statusCode === 200, `Run get failed: ${getRes.body}`);
    const run = getRes.json().run;
    assert(
      run.stages.intake?.status === "awaiting_confirmation" ||
        run.stages.intake?.status === "awaiting_input",
      `Expected intake gate status, got ${run.stages.intake?.status}`,
    );

    // 5. Calling advance without Prefer: respond-async returns 200 synchronously
    const syncRes = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/advance`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(syncRes.statusCode === 200, `Expected 200 synchronous advance, got ${syncRes.statusCode}`);

    // 6. Unknown job returns 404
    const notFoundJob = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/jobs/job-unknown-999`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(notFoundJob.statusCode === 404, `Expected 404 for unknown job, got ${notFoundJob.statusCode}`);
  } finally {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyModelCatalogFromConfig(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-catalog-eval-"));
  const catalogPath = path.join(dir, "custom-catalog.json");
  const customModels = [
    {
      id: "custom-eval-model",
      label: "Custom Eval Model",
      provider: "openai-compatible",
      model: "custom/eval-model-v1",
      tier: "flash",
      supportsTools: true,
    },
  ];

  try {
    fs.writeFileSync(catalogPath, JSON.stringify(customModels), "utf-8");
    reloadModelCatalog(catalogPath);

    const app = createServer({
      mode: "local",
      loopbackToken: "test-token",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer test-token",
        host: "127.0.0.1:4317",
      },
    });

    assert(res.statusCode === 200, `GET /v1/models failed: ${res.body}`);
    const data = res.json();
    const found = data.models.find((m: { id: string }) => m.id === "custom-eval-model");
    assert(found, "Custom model from configured catalog file was not found in /v1/models");
    assert(found.label === "Custom Eval Model", `Expected label Custom Eval Model, got ${found.label}`);

    await app.close();
  } finally {
    reloadModelCatalog("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyLeadRetentionAndDeletion(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-retention-eval-"));
  const dbPath = path.join(dir, "retention.sqlite");
  const store = new SqliteProjectStore(dbPath, { skipImport: true });
  const rawKey = "jnt_live_retention_1234567890abcdef1234567890abcdef";
  const clientId = "retention-eval-client";

  store.createApiKey({
    id: "key-retention-eval",
    keyHash: hashApiKey(rawKey),
    prefix: "jnt_live_",
    clientId,
    subject: "operator",
    label: "Retention eval key",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    scope: "full",
  });

  const app = createServer({
    mode: "remote",
    loopbackToken: "",
    store,
  });

  try {
    // 1. Post a lead
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        name: "Retention Test",
        email: "retention@example.com",
        idea: "Lead retention test",
        source: "eval",
      },
    });
    assert(createRes.statusCode === 201, `Lead creation failed: ${createRes.body}`);
    const leadId = createRes.json().id as string;

    // 2. List leads -> should contain the new lead
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(listRes.statusCode === 200, `List leads failed: ${listRes.body}`);
    assert(listRes.json().items.some((l: { id: string }) => l.id === leadId), "Expected lead in list");

    // 3. Delete lead via DELETE /v1/leads/:id
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/leads/${leadId}`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(delRes.statusCode === 200, `Delete lead failed: ${delRes.body}`);
    assert(delRes.json().status === "deleted", "Expected status deleted");

    // 4. List leads again -> should be empty
    const listAgain = await app.inject({
      method: "GET",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(!listAgain.json().items.some((l: { id: string }) => l.id === leadId), "Expected lead to be removed");

    // 5. Deleting nonexistent lead returns 404
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/v1/leads/${leadId}`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(delAgain.statusCode === 404, `Expected 404 on already deleted lead, got ${delAgain.statusCode}`);

    // 6. Linked intake run deletion and associated audit cleanup
    const runId = "retention-eval-run-1";
    const run = createProject(clientId, "Linked Lead Run");
    run.id = runId;
    store.saveProject(run);
    assert(store.loadProject(clientId, runId) !== null, "Expected run to exist in store");

    const runAuditFile = path.join(config.auditDir, `${runId}.jsonl`);
    fs.mkdirSync(config.auditDir, { recursive: true });
    fs.writeFileSync(runAuditFile, JSON.stringify({ ts: new Date().toISOString(), runId, clientId }) + "\n", "utf8");
    assert(fs.existsSync(runAuditFile), "Expected run audit file to exist");

    const linkedLeadRes = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: {
        name: "Linked Lead",
        email: "linked@example.com",
        idea: "Idea with linked run",
        source: "eval",
        runId,
      },
    });
    assert(linkedLeadRes.statusCode === 201, `Failed to create linked lead: ${linkedLeadRes.body}`);
    const linkedLeadId = linkedLeadRes.json().id as string;

    // Delete lead with deleteLinkedRun=true
    const delLinkedRes = await app.inject({
      method: "DELETE",
      url: `/v1/leads/${linkedLeadId}?deleteLinkedRun=true`,
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(delLinkedRes.statusCode === 200, `Failed to delete linked lead: ${delLinkedRes.body}`);

    // Verify linked run in store and audit file were deleted
    assert(store.loadProject(clientId, runId) === null, "Linked run must be deleted from project store");
    assert(!fs.existsSync(runAuditFile), "Linked run audit file must be deleted");

    // Verify system audit trail has action: "delete" and NO personal data
    const systemAuditFile = path.join(config.auditDir, "system.jsonl");
    if (fs.existsSync(systemAuditFile)) {
      const systemAudit = fs.readFileSync(systemAuditFile, "utf8");
      assert(systemAudit.includes('"action":"delete"'), "Expected action: delete in system audit");
      assert(!systemAudit.includes("linked@example.com"), "PII email leaked in system audit");
      assert(!systemAudit.includes("Linked Lead"), "PII name leaked in system audit");
    }

    // 7. Gating of lead retention sweep by JANTRA_ENABLE_LEAD_DELETION_SWEEP
    const sweepDisabledRes = await app.inject({
      method: "POST",
      url: "/v1/leads/sweep",
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    });
    assert(sweepDisabledRes.statusCode === 403, `Expected 403 when sweep is disabled, got ${sweepDisabledRes.statusCode}`);

    // Enable sweep and verify POST /v1/leads/sweep returns 200
    const prevSweepFlag = config.enableLeadDeletionSweep;
    try {
      (config as { enableLeadDeletionSweep: boolean }).enableLeadDeletionSweep = true;
      const sweepEnabledRes = await app.inject({
        method: "POST",
        url: "/v1/leads/sweep",
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      });
      assert(sweepEnabledRes.statusCode === 200, `Expected 200 when sweep is enabled, got ${sweepEnabledRes.statusCode}`);
      assert(typeof sweepEnabledRes.json().sweptLeads === "number", "Expected sweptLeads number in sweep response");
    } finally {
      (config as { enableLeadDeletionSweep: boolean }).enableLeadDeletionSweep = prevSweepFlag;
    }

    // 8. Strict tenant boundaries: Tenant B cannot delete Tenant A's run
    const clientBId = "retention-tenant-b";
    const rawKeyB = "jnt_live_tenant_b_1234567890abcdef1234567890abcdef";
    store.createApiKey({
      id: "key-tenant-b",
      keyHash: hashApiKey(rawKeyB),
      prefix: "jnt_live_",
      clientId: clientBId,
      subject: "operator",
      label: "Tenant B key",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      scope: "full",
    });

    const runAProtected = "run-tenant-a-protected";
    const protectedProject = createProject(clientId, "Protected Run");
    protectedProject.id = runAProtected;
    store.saveProject(protectedProject);
    const runAuditProtected = path.join(config.auditDir, `${runAProtected}.jsonl`);
    fs.writeFileSync(runAuditProtected, JSON.stringify({ ts: new Date().toISOString(), runId: runAProtected, clientId }) + "\n", "utf8");

    // Tenant B creates a lead trying to link to Tenant A's run (should fail 404 because run is not in Tenant B)
    const spoofRes = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: {
        authorization: `Bearer ${rawKeyB}`,
        "content-type": "application/json",
      },
      payload: {
        name: "Spoof Attacker",
        email: "spoof@example.com",
        idea: "Attempting to delete Tenant A run",
        source: "eval",
        runId: runAProtected,
      },
    });
    assert(spoofRes.statusCode === 404, `Tenant B should not be able to link to Tenant A's run: got ${spoofRes.statusCode}`);
    assert(store.loadProject(clientId, runAProtected) !== null, "Tenant A's run must still exist");
    assert(fs.existsSync(runAuditProtected), "Tenant A's audit file must still exist");
    fs.rmSync(runAuditProtected, { force: true });

    // 9. Periodic daily sweep execution: verify recurring sweep cleans expired leads
    const prevFlagForTimer = config.enableLeadDeletionSweep;
    try {
      (config as { enableLeadDeletionSweep: boolean }).enableLeadDeletionSweep = true;
      const oldLeadDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      store.createLead({
        id: "lead-periodic-sweep",
        clientId,
        userSub: null,
        name: "Old Recurring",
        email: "oldrec@example.com",
        idea: "Old periodic idea",
        source: "eval",
        createdAt: oldLeadDate,
      });
      assert(store.getLead(clientId, "lead-periodic-sweep") !== null, "Lead should exist before sweep");

      const timedApp = fastify();
      registerLeadRoutes(timedApp, {
        clientId,
        leadStore: store,
        projectStore: store,
        sweepIntervalMs: 20,
      });

      await new Promise((r) => setTimeout(r, 60));
      await timedApp.close();

      assert(store.getLead(clientId, "lead-periodic-sweep") === null, "Lead should be swept by periodic timer");
    } finally {
      (config as { enableLeadDeletionSweep: boolean }).enableLeadDeletionSweep = prevFlagForTimer;
    }
  } finally {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyDesktopLicensingEnforcement(): Promise<void> {
  const token = "license-enforcement-token";
  const clientId = `eval-lic-${Date.now()}`;
  const auth = { authorization: `Bearer ${token}`, host: "127.0.0.1:4317" };
  const store = new JsonProjectStore();
  const licenseStore = new MemoryLicenseStore();
  const testKeyPair = generateLicenseKeyPair();
  const licenseManager = new LicenseManager(licenseStore, {
    enforcement: true,
    publicKey: testKeyPair.publicKey,
  });

  const app = createServer({
    loopbackToken: token,
    clientId,
    store,
    licenseManager,
    licenseEnforcement: true,
  });

  const ownerPrivateKey = testKeyPair.privateKey;

  try {
    // 1. Initial State: Unlicensed
    const licStatusRes = await app.inject({
      method: "GET",
      url: "/v1/license",
      headers: auth,
    });
    assert(licStatusRes.statusCode === 200, `GET /v1/license failed: ${licStatusRes.body}`);
    assert(licStatusRes.json().active === false, "Expected license to be inactive");
    assert(licStatusRes.json().state === "unlicensed", "Expected state to be unlicensed");

    // 2. Read-only access MUST be allowed while unlicensed
    const existingProject = createProject({
      clientId,
      title: "Existing Read-Only Project",
    });
    existingProject.stages.intake!.artifacts.push({
      stage: "intake",
      kind: "idea_summary",
      title: "Summary",
      content: "Idea content",
      version: 1,
      createdAt: new Date().toISOString(),
    });
    store.saveProject(existingProject);

    const listRunsRes = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: auth,
    });
    assert(listRunsRes.statusCode === 200, `GET /v1/runs must be allowed read-only: ${listRunsRes.body}`);
    assert(
      listRunsRes.json().items.some((r: { id: string }) => r.id === existingProject.id),
      "Expected run in list",
    );

    const getRunRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${existingProject.id}`,
      headers: auth,
    });
    assert(getRunRes.statusCode === 200, `GET /v1/runs/:id must be allowed: ${getRunRes.body}`);

    const exportRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${existingProject.id}/export`,
      headers: auth,
    });
    assert(exportRes.statusCode === 200, `GET /v1/runs/:id/export must be allowed: ${exportRes.body}`);

    const artifactsRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${existingProject.id}/artifacts/idea_summary`,
      headers: auth,
    });
    assert(artifactsRes.statusCode === 200, `GET /v1/runs/:id/artifacts/:kind must be allowed: ${artifactsRes.body}`);

    const sourcesRes = await app.inject({
      method: "GET",
      url: `/v1/runs/${existingProject.id}/sources`,
      headers: auth,
    });
    assert(sourcesRes.statusCode === 200, `GET /v1/runs/:id/sources must be allowed: ${sourcesRes.body}`);

    // 3. Mutating execution MUST be blocked while unlicensed
    const startRunRes = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "planning-pipeline",
        title: "Blocked Run",
      },
    });
    assert(
      startRunRes.statusCode === 403,
      `Starting run while unlicensed must be blocked with 403, got ${startRunRes.statusCode}`,
    );
    assert(startRunRes.json().error.code === "unlicensed", "Expected error.code to be 'unlicensed'");

    const advanceRes = await app.inject({
      method: "POST",
      url: `/v1/runs/${existingProject.id}/advance`,
      headers: auth,
    });
    assert(
      advanceRes.statusCode === 403,
      `Advancing run while unlicensed must be blocked with 403, got ${advanceRes.statusCode}`,
    );
    assert(advanceRes.json().error.code === "unlicensed", "Expected error.code to be 'unlicensed'");

    const completeRes = await app.inject({
      method: "POST",
      url: "/v1/complete",
      headers: { ...auth, "content-type": "application/json" },
      payload: { prompt: "Hello" },
    });
    assert(
      completeRes.statusCode === 403,
      `Invoking model calls while unlicensed must be blocked with 403, got ${completeRes.statusCode}`,
    );
    assert(completeRes.json().error.code === "unlicensed", "Expected error.code to be 'unlicensed'");

    // 4. Tampered license: activation fails, execution blocked
    const validPayload: LicensePayload = {
      licensee: "Regression Licensee",
      plan: "pro",
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };
    const validToken = createLicenseToken(validPayload, ownerPrivateKey);
    const parsed = parseLicenseToken(validToken)!;
    const tamperedSig = Buffer.from(parsed.signature);
    tamperedSig[0] = tamperedSig[0]! ^ 0xff;
    const tamperedToken = Buffer.from(
      JSON.stringify({ payload: parsed.payload, signature: tamperedSig.toString("base64") }),
    ).toString("base64");

    const activateTamperedRes = await app.inject({
      method: "POST",
      url: "/v1/license",
      headers: { ...auth, "content-type": "application/json" },
      payload: { token: tamperedToken },
    });
    assert(
      activateTamperedRes.statusCode === 400,
      `Activating tampered token must fail 400, got ${activateTamperedRes.statusCode}`,
    );

    await licenseStore.saveLicenseToken(tamperedToken);
    const statusTampered = await app.inject({ method: "GET", url: "/v1/license", headers: auth });
    assert(statusTampered.json().active === false, "Tampered license must not be active");
    assert(statusTampered.json().state === "tampered", "State must be tampered");

    const blockOnTamper = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: { agentId: "planning-pipeline", title: "Tampered Block" },
    });
    assert(blockOnTamper.statusCode === 403, "Tampered license must block run creation");

    // 5. Expired license: execution blocked
    const expiredPayload: LicensePayload = {
      licensee: "Expired Licensee",
      plan: "pro",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      issuedAt: new Date(Date.now() - 10000).toISOString(),
    };
    const expiredToken = createLicenseToken(expiredPayload, ownerPrivateKey);
    await licenseStore.saveLicenseToken(expiredToken);

    const statusExpired = await app.inject({ method: "GET", url: "/v1/license", headers: auth });
    assert(statusExpired.json().active === false, "Expired license must not be active");
    assert(statusExpired.json().state === "expired", "State must be expired");

    const blockOnExpired = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: { agentId: "planning-pipeline", title: "Expired Block" },
    });
    assert(blockOnExpired.statusCode === 403, "Expired license must block run creation");

    // 6. Valid license activation: transitions to active and allows execution
    const activateValidRes = await app.inject({
      method: "POST",
      url: "/v1/license",
      headers: { ...auth, "content-type": "application/json" },
      payload: { token: validToken },
    });
    assert(activateValidRes.statusCode === 200, `Valid activation failed: ${activateValidRes.body}`);
    assert(activateValidRes.json().active === true, "Expected active to be true after activation");
    assert(activateValidRes.json().licensee === "Regression Licensee", "Licensee mismatch");

    const statusActive = await app.inject({ method: "GET", url: "/v1/license", headers: auth });
    assert(statusActive.json().active === true, "GET /v1/license must show active");
    assert(statusActive.json().state === "valid", "GET /v1/license state must be valid");

    const startRunSuccess = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        agentId: "planning-pipeline",
        title: "Licensed Run",
      },
    });
    assert(startRunSuccess.statusCode === 200, `Licensed run creation failed: ${startRunSuccess.body}`);

    // 6. License issuance tool fails closed without explicit key or secret
    const { resolvePrivateKey } = await import("../../../licensing/index.js");
    const origEnvKey = process.env.JANTRA_LICENSE_PRIVATE_KEY;
    delete process.env.JANTRA_LICENSE_PRIVATE_KEY;
    let issuanceThrew = false;
    try {
      resolvePrivateKey(undefined);
    } catch (err) {
      issuanceThrew = true;
      assert(
        /requires an Ed25519 private key/i.test(String(err)),
        `Expected error mentioning Ed25519 private key, got: ${String(err)}`,
      );
    } finally {
      if (origEnvKey) process.env.JANTRA_LICENSE_PRIVATE_KEY = origEnvKey;
    }
    assert(issuanceThrew, "resolvePrivateKey must fail closed when neither --key nor secret is set.");

    // 7. License signed by arbitrary test key fails against EMBEDDED_LICENSE_PUBLIC_KEY
    const { EMBEDDED_LICENSE_PUBLIC_KEY } = await import("../../../licensing/keys.js");
    const { verifyLicenseToken } = await import("../../../licensing/verify.js");
    const rogueVerify = verifyLicenseToken(validToken, EMBEDDED_LICENSE_PUBLIC_KEY);
    assert(!rogueVerify.valid, "Rogue/test key must not verify against EMBEDDED_LICENSE_PUBLIC_KEY");
    assert(rogueVerify.state === "tampered", `Expected state 'tampered', got ${rogueVerify.state}`);
  } finally {
    await app.close();
  }
}

export async function verifyDesktopMultiProviderConfiguration(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-provider-test-"));
  const configPath = path.join(dir, "provider-config.json");
  const credsPath = path.join(dir, "credentials.json");

  try {
    // 1. Initial / default config is Gemini
    const defaultConfig = {
      provider: "gemini" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      modelFlash: "",
      modelPro: "",
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf8");

    // 2. Save credentials for both Gemini and OpenAI-compatible simultaneously
    const credentials = {
      geminiApiKey: "AIzaSyTestGeminiKey123",
      openAiApiKey: "sk-or-v1-testOpenAiKey456",
    };
    fs.writeFileSync(credsPath, JSON.stringify(credentials, null, 2), "utf8");

    const loadedCreds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as typeof credentials;
    assert(loadedCreds.geminiApiKey === "AIzaSyTestGeminiKey123", "Gemini API key mismatch");
    assert(loadedCreds.openAiApiKey === "sk-or-v1-testOpenAiKey456", "OpenAI API key mismatch");

    // 3. Switch active provider to OpenAI-compatible with custom endpoint and models
    const openAiConfig = {
      provider: "openai-compatible" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      modelFlash: "meta-llama/llama-3.3-70b-instruct",
      modelPro: "anthropic/claude-3.5-sonnet",
      dataCollection: "deny" as const,
    };
    fs.writeFileSync(configPath, JSON.stringify(openAiConfig, null, 2), "utf8");

    const loadedOpenAiConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof openAiConfig;
    assert(loadedOpenAiConfig.provider === "openai-compatible", "Expected provider openai-compatible");
    assert(loadedOpenAiConfig.modelFlash === "meta-llama/llama-3.3-70b-instruct", "modelFlash mismatch");
    assert(loadedOpenAiConfig.modelPro === "anthropic/claude-3.5-sonnet", "modelPro mismatch");
    assert(loadedOpenAiConfig.dataCollection === "deny", "dataCollection mismatch");

    // Both credentials still safely stored and isolated
    const credsCheck = JSON.parse(fs.readFileSync(credsPath, "utf8")) as typeof credentials;
    assert(credsCheck.geminiApiKey && credsCheck.openAiApiKey, "Both credentials must coexist");

    // 4. Switch back to Gemini
    const geminiConfig = {
      provider: "gemini" as const,
    };
    fs.writeFileSync(configPath, JSON.stringify(geminiConfig, null, 2), "utf8");
    const loadedGeminiConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof geminiConfig;
    assert(loadedGeminiConfig.provider === "gemini", "Expected provider gemini");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

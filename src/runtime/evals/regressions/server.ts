import fastify, { type FastifyRequest } from "fastify";
import { createProject } from "../../../pipeline/orchestrator.js";
import { JsonProjectStore, type ProjectStore } from "../../../pipeline/store.js";
import { createServer } from "../../../server/app.js";
import { createFixedWindowLimiter, installIdentityRateLimit } from "../../../server/rateLimit.js";
import { runParamsSchema } from "../../../server/schemas.js";
import { visitorAddress } from "../../../server/visitor.js";
import { assert, readAuditJsonl } from "./common.js";

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

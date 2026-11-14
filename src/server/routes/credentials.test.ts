import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../app.js";
import { SqliteProjectStore } from "../../pipeline/store/sqlite.js";
import { config } from "../../config.js";
import type { OpsReportingProfile } from "../../pipeline/store.js";

describe("Admin & Tenant Credential Routes (T-018)", () => {
  const originalSecretsKey = config.secretsKey;
  const adminToken = "adm_secret_token_12345";

  const sampleProfile: Omit<OpsReportingProfile, "confirmedAt" | "confirmedBy" | "createdAt" | "updatedAt"> = {
    clientId: "client-route-test",
    businessName: "Route Test Store",
    currency: "USD",
    kpiSpec: {
      kpis: [
        { id: "orders_count", name: "Order Count", formula: "COUNT(orders.id)", minHistoryPeriods: 1 },
      ],
    },
    binding: {
      connectors: [
        { id: "stripe-sub", type: "stripe", role: "subscriptions", config: {} },
      ],
      overlapRules: [],
    },
    delivery: {
      channel: "webhook",
      credentialRef: "report-webhook",
    },
  };

  it("admin routes require X-Jantra-Admin-Token and reject unauthorized requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-admin-creds-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });
      const app = createServer({
        mode: "remote",
        loopbackToken: "",
        adminToken,
        store,
        apiKeyStore: store,
      });

      // No admin token -> 401
      const resNoToken = await app.inject({
        method: "PUT",
        url: "/v1/admin/clients/tenant-x/credentials/stripe",
        headers: { "Content-Type": "application/json" },
        payload: { credentials: { STRIPE_API_KEY: "sk_test_123" } },
      });
      assert.equal(resNoToken.statusCode, 401);

      // Invalid admin token -> 401
      const resBadToken = await app.inject({
        method: "PUT",
        url: "/v1/admin/clients/tenant-x/credentials/stripe",
        headers: {
          "Content-Type": "application/json",
          "x-jantra-admin-token": "wrong-token",
        },
        payload: { credentials: { STRIPE_API_KEY: "sk_test_123" } },
      });
      assert.equal(resBadToken.statusCode, 401);

      // Valid admin token -> 200
      const resOk = await app.inject({
        method: "PUT",
        url: "/v1/admin/clients/tenant-x/credentials/stripe",
        headers: {
          "Content-Type": "application/json",
          "x-jantra-admin-token": adminToken,
        },
        payload: { credentials: { STRIPE_API_KEY: "sk_test_123" } },
      });
      assert.equal(resOk.statusCode, 200);
      const okBody = resOk.json();
      assert.equal(okBody.ok, true);
      assert.equal(okBody.clientId, "tenant-x");
      assert.equal(okBody.connector, "stripe");

      // GET admin credentials returns metadata only, never secret values
      const resGet = await app.inject({
        method: "GET",
        url: "/v1/admin/clients/tenant-x/credentials/stripe",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resGet.statusCode, 200);
      const getJson = resGet.json();
      assert.equal(getJson.clientId, "tenant-x");
      assert.equal(getJson.connector, "stripe");
      assert.equal(getJson.configured, true);
      assert.equal(getJson.credentials, undefined);
      assert(!JSON.stringify(getJson).includes("sk_test_123"), "secret must not appear in response");

      // GET admin credentials for non-existent client -> 404
      const resGetMissing = await app.inject({
        method: "GET",
        url: "/v1/admin/clients/tenant-y/credentials/stripe",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resGetMissing.statusCode, 404);

      // LIST connectors
      const resList = await app.inject({
        method: "GET",
        url: "/v1/admin/clients/tenant-x/credentials",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resList.statusCode, 200);
      assert.deepEqual(resList.json().connectors, ["stripe"]);

      // DELETE credentials
      const resDel = await app.inject({
        method: "DELETE",
        url: "/v1/admin/clients/tenant-x/credentials/stripe",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resDel.statusCode, 200);

      await app.close();
      store.close();
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admin routes manage ops reporting profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-admin-profile-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });
      const app = createServer({
        mode: "remote",
        loopbackToken: "",
        adminToken,
        store,
        apiKeyStore: store,
      });

      // PUT ops-profile
      const resPut = await app.inject({
        method: "PUT",
        url: "/v1/admin/clients/client-route-test/ops-profile",
        headers: {
          "Content-Type": "application/json",
          "x-jantra-admin-token": adminToken,
        },
        payload: sampleProfile,
      });
      assert.equal(resPut.statusCode, 200);
      assert.equal(resPut.json().ok, true);

      // GET ops-profile
      const resGet = await app.inject({
        method: "GET",
        url: "/v1/admin/clients/client-route-test/ops-profile",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resGet.statusCode, 200);
      assert.equal(resGet.json().profile.businessName, "Route Test Store");

      // DELETE ops-profile
      const resDel = await app.inject({
        method: "DELETE",
        url: "/v1/admin/clients/client-route-test/ops-profile",
        headers: { "x-jantra-admin-token": adminToken },
      });
      assert.equal(resDel.statusCode, 200);

      await app.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tenant routes strictly enforce client isolation and reject public-scope keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-tenant-creds-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });

      const app = createServer({
        mode: "remote",
        loopbackToken: "",
        store,
        apiKeyStore: store,
        apiKeys: [
          {
            key: "full_key_alpha",
            clientId: "tenant-alpha",
            subject: "operator-alpha",
          },
          {
            key: "public_key_visitor",
            clientId: "tenant-alpha",
            subject: "web",
          },
        ],
      });

      // Public key must be rejected with 403 Forbidden
      const resPublic = await app.inject({
        method: "PUT",
        url: "/v1/credentials/stripe",
        headers: {
          "Authorization": "Bearer public_key_visitor",
          "Content-Type": "application/json",
        },
        payload: { credentials: { STRIPE_API_KEY: "sk_public" } },
      });
      assert.equal(resPublic.statusCode, 403);

      // Tenant PUT/GET/DELETE must reject with 403 Forbidden
      const resPut = await app.inject({
        method: "PUT",
        url: "/v1/credentials/stripe",
        headers: {
          "Authorization": "Bearer full_key_alpha",
          "Content-Type": "application/json",
        },
        payload: { credentials: { STRIPE_API_KEY: "sk_alpha_secret" } },
      });
      assert.equal(resPut.statusCode, 403);
      assert(!JSON.stringify(resPut.json()).includes("sk_alpha_secret"));

      const resGet = await app.inject({
        method: "GET",
        url: "/v1/credentials/stripe",
        headers: { "Authorization": "Bearer full_key_alpha" },
      });
      assert.equal(resGet.statusCode, 403);

      // Store credentials via admin/store for tenant-alpha
      store.setConnectorCredentials("tenant-alpha", "stripe", { STRIPE_API_KEY: "sk_alpha_secret" });

      // Tenant GET /v1/credentials lists only configured connector ids, no secrets
      const resList = await app.inject({
        method: "GET",
        url: "/v1/credentials",
        headers: { "Authorization": "Bearer full_key_alpha" },
      });
      assert.equal(resList.statusCode, 200);
      assert.deepEqual(resList.json(), { clientId: "tenant-alpha", connectors: ["stripe"] });
      assert(!JSON.stringify(resList.json()).includes("sk_alpha_secret"), "no secrets in list response");

      await app.close();
      store.close();
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

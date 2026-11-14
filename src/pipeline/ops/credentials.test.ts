import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { config } from "../../config.js";
import { JsonProjectStore } from "../store.js";
import { SqliteProjectStore } from "../store/sqlite.js";
import type { OpsReportingProfile } from "../store.js";
import { DecryptionError } from "../../security/encryption.js";

describe("Per-Client Connector Credentials & Ops Profiles (T-018)", () => {
  const originalSecretsKey = config.secretsKey;

  const sampleProfile: OpsReportingProfile = {
    clientId: "tenant-alpha",
    businessName: "Alpha Retailers",
    description: "Multi-channel retail store",
    currency: "USD",
    fiscalCalendar: "January-December",
    knownEvents: [
      { name: "Black Friday Sale", date: "2026-11-27", type: "promo" },
    ],
    kpiSpec: {
      kpis: [
        { id: "revenue", name: "Gross Revenue", formula: "SUM(orders.amount)", minHistoryPeriods: 3 },
      ],
      anomalyConfig: {
        sensitivity: "medium",
        alertBudget: 3,
      },
    },
    binding: {
      connectors: [
        { id: "stripe-sub", type: "stripe", role: "subscriptions", config: {} },
        { id: "shopify-sales", type: "shopify", role: "sales", config: { shopName: "alpha-store" } },
      ],
      overlapRules: [],
    },
    delivery: {
      channel: "webhook",
      webhookUrl: "https://example.com/webhooks/ops-report",
      webhookSecret: "whsec_test_secret",
    },
    confirmedAt: "2026-11-14T00:00:00.000Z",
    confirmedBy: "operator@xolver.in",
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  };

  it("stores and isolates encrypted connector credentials in JsonProjectStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-json-creds-"));
    const origProjectDir = config.projectDir;
    try {
      (config as any).projectDir = dir;
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";

      const store = new JsonProjectStore();

      // Set credentials for tenant-alpha
      store.setConnectorCredentials("tenant-alpha", "stripe", { STRIPE_API_KEY: "sk_test_alpha_stripe" });
      store.setConnectorCredentials("tenant-alpha", "shopify", {
        SHOPIFY_SHOP_NAME: "alpha-shop",
        SHOPIFY_ACCESS_TOKEN: "shpat_alpha_token",
      });

      // Set credentials for tenant-beta
      store.setConnectorCredentials("tenant-beta", "stripe", { STRIPE_API_KEY: "sk_test_beta_stripe" });

      // Verify tenant-alpha credentials
      const alphaStripe = store.getConnectorCredentials("tenant-alpha", "stripe");
      assert.deepEqual(alphaStripe, { STRIPE_API_KEY: "sk_test_alpha_stripe" });

      const alphaShopify = store.getConnectorCredentials("tenant-alpha", "shopify");
      assert.deepEqual(alphaShopify, {
        SHOPIFY_SHOP_NAME: "alpha-shop",
        SHOPIFY_ACCESS_TOKEN: "shpat_alpha_token",
      });

      // Verify tenant-beta credentials
      const betaStripe = store.getConnectorCredentials("tenant-beta", "stripe");
      assert.deepEqual(betaStripe, { STRIPE_API_KEY: "sk_test_beta_stripe" });

      // Verify tenant isolation: tenant-beta cannot access tenant-alpha's shopify
      const betaShopify = store.getConnectorCredentials("tenant-beta", "shopify");
      assert.equal(betaShopify, null);

      // Verify listing connectors
      assert.deepEqual(store.listConnectorCredentials("tenant-alpha"), ["shopify", "stripe"]);
      assert.deepEqual(store.listConnectorCredentials("tenant-beta"), ["stripe"]);

      // Verify deleting credentials
      assert.equal(store.deleteConnectorCredentials("tenant-alpha", "stripe"), true);
      assert.equal(store.getConnectorCredentials("tenant-alpha", "stripe"), null);
      assert.deepEqual(store.listConnectorCredentials("tenant-alpha"), ["shopify"]);
    } finally {
      (config as any).projectDir = origProjectDir;
      (config as any).secretsKey = originalSecretsKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and isolates encrypted connector credentials in SqliteProjectStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-sqlite-creds-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      (config as any).secretsKey = "test-secret-key-32-chars-long!!";
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });

      // Set credentials for tenant-alpha
      store.setConnectorCredentials("tenant-alpha", "stripe", { STRIPE_API_KEY: "sk_test_alpha_stripe" });
      store.setConnectorCredentials("tenant-alpha", "shopify", {
        SHOPIFY_SHOP_NAME: "alpha-shop",
        SHOPIFY_ACCESS_TOKEN: "shpat_alpha_token",
      });

      // Set credentials for tenant-beta
      store.setConnectorCredentials("tenant-beta", "stripe", { STRIPE_API_KEY: "sk_test_beta_stripe" });

      // Verify tenant-alpha credentials
      const alphaStripe = store.getConnectorCredentials("tenant-alpha", "stripe");
      assert.deepEqual(alphaStripe, { STRIPE_API_KEY: "sk_test_alpha_stripe" });

      // Verify tenant-beta credentials
      const betaStripe = store.getConnectorCredentials("tenant-beta", "stripe");
      assert.deepEqual(betaStripe, { STRIPE_API_KEY: "sk_test_beta_stripe" });

      // Verify tenant isolation: tenant-beta cannot access tenant-alpha's shopify
      const betaShopify = store.getConnectorCredentials("tenant-beta", "shopify");
      assert.equal(betaShopify, null);

      // Verify listing connectors
      assert.deepEqual(store.listConnectorCredentials("tenant-alpha"), ["shopify", "stripe"]);
      assert.deepEqual(store.listConnectorCredentials("tenant-beta"), ["stripe"]);

      // Verify deleting credentials
      assert.equal(store.deleteConnectorCredentials("tenant-alpha", "stripe"), true);
      assert.equal(store.getConnectorCredentials("tenant-alpha", "stripe"), null);

      store.close();
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on decryption failure when secret key is changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-sqlite-fail-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      (config as any).secretsKey = "initial-secret-key-32-chars-ok!!";
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });

      store.setConnectorCredentials("tenant-gamma", "stripe", { STRIPE_API_KEY: "sk_test_gamma" });

      // Change key to simulate invalid key / corrupted credentials
      (config as any).secretsKey = "different-secret-key-32-chars!!";

      assert.throws(
        () => store.getConnectorCredentials("tenant-gamma", "stripe"),
        (err: unknown) => err instanceof DecryptionError,
      );

      store.close();
    } finally {
      (config as any).secretsKey = originalSecretsKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and retrieves operator-confirmed reporting profile in SqliteProjectStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-profile-sqlite-"));
    const sqlitePath = join(dir, "jantra.sqlite");
    try {
      const store = new SqliteProjectStore(sqlitePath, { skipImport: true });

      store.setOpsProfile(sampleProfile);

      const loaded = store.getOpsProfile("tenant-alpha");
      assert.ok(loaded);
      assert.equal(loaded.businessName, "Alpha Retailers");
      assert.equal(loaded.kpiSpec.kpis[0]!.id, "revenue");
      assert.equal(loaded.delivery?.channel, "webhook");
      assert.equal(loaded.delivery?.webhookUrl, "https://example.com/webhooks/ops-report");

      // Non-existent client returns null
      assert.equal(store.getOpsProfile("unknown-client"), null);

      // Deletion works
      assert.equal(store.deleteOpsProfile("tenant-alpha"), true);
      assert.equal(store.getOpsProfile("tenant-alpha"), null);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and retrieves operator-confirmed reporting profile in JsonProjectStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "jantra-profile-json-"));
    const origProjectDir = config.projectDir;
    try {
      (config as any).projectDir = dir;
      const store = new JsonProjectStore();

      store.setOpsProfile(sampleProfile);

      const loaded = store.getOpsProfile("tenant-alpha");
      assert.ok(loaded);
      assert.equal(loaded.businessName, "Alpha Retailers");
      assert.equal(loaded.binding.connectors.length, 2);

      // Non-existent client returns null
      assert.equal(store.getOpsProfile("unknown-client"), null);

      // Deletion works
      assert.equal(store.deleteOpsProfile("tenant-alpha"), true);
      assert.equal(store.getOpsProfile("tenant-alpha"), null);
    } finally {
      (config as any).projectDir = origProjectDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

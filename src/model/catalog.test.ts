import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BUILTIN_MODEL_CATALOG,
  catalogSchema,
  loadModelCatalog,
  reloadModelCatalog,
  resolveCatalog,
  isCatalogModelAvailable,
  checkCatalogModels,
  type CatalogModel,
} from "./catalog.js";
import { config } from "../config.js";

describe("Model Catalog (T-026)", () => {
  it("builtin catalog passes schema validation", () => {
    const validated = catalogSchema.parse(BUILTIN_MODEL_CATALOG);
    assert(validated.length > 0, "Builtin catalog must have entries");
    assert(validated.some((m) => m.id === "gemini-2.5-flash"));
    assert(validated.some((m) => m.id === "gemini-2.5-pro"));
  });

  it("loads model catalog from custom JSON file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-catalog-"));
    const catalogPath = path.join(dir, "custom-catalog.json");
    const customModels: CatalogModel[] = [
      {
        id: "custom-flash-model",
        label: "Custom Flash",
        provider: "gemini",
        model: "gemini-2.5-flash",
        tier: "flash",
        supportsTools: true,
      },
      {
        id: "custom-router-model",
        label: "Custom Router Model",
        provider: "openai-compatible",
        model: "meta-llama/llama-3.3-70b-instruct",
        tier: "pro",
        supportsTools: true,
      },
    ];

    try {
      fs.writeFileSync(catalogPath, JSON.stringify(customModels), "utf-8");

      const loaded = loadModelCatalog(catalogPath);
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0]?.id, "custom-flash-model");
      assert.equal(loaded[1]?.provider, "openai-compatible");

      // Test reloadModelCatalog
      reloadModelCatalog(catalogPath);
      assert.equal(resolveCatalog("custom-flash-model")?.label, "Custom Flash");

      // Restore built-in catalog
      reloadModelCatalog("");
      assert(resolveCatalog("gemini-2.5-flash"), "Built-in model must resolve after restore");
    } finally {
      reloadModelCatalog("");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when catalog file does not exist", () => {
    assert.throws(() => {
      loadModelCatalog("nonexistent-catalog-path-12345.json");
    }, /Configured model catalog file was not found/);
  });

  it("throws when catalog file contains invalid schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-catalog-invalid-"));
    const catalogPath = path.join(dir, "invalid-catalog.json");
    try {
      // Missing provider and invalid tier
      fs.writeFileSync(
        catalogPath,
        JSON.stringify([{ id: "bad-model", label: "Bad" }]),
        "utf-8",
      );
      assert.throws(() => {
        loadModelCatalog(catalogPath);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evaluates availability based on provider configuration", () => {
    const mockModel: CatalogModel = {
      id: "test-model",
      label: "Test",
      provider: "gemini",
      model: "gemini-2.5-flash",
      tier: "flash",
      supportsTools: true,
    };
    // Under mock provider, models are available
    assert.equal(isCatalogModelAvailable(mockModel), true);
  });

  it("createServer with checkCatalogModels: false never invokes the catalog probe", async () => {
    const { createServer } = await import("../server/app.js");
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const app = createServer({
        loopbackToken: "test-token",
        checkCatalogModels: false,
      });
      await app.ready();
      assert.equal(fetchCalled, false, "Catalog probe must not be invoked when checkCatalogModels: false");
      await app.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("checkCatalogModels with mocked endpoint validates configured model ids against available models", async () => {
    const origFetch = globalThis.fetch;
    const origConfig = { ...config };
    let requestedUrl = "";

    (config as any).provider = "openai-compatible";
    (config as any).baseUrl = "https://mock.openrouter.test/api/v1";
    (config as any).llmApiKey = "test-mock-key";

    globalThis.fetch = (async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          data: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const testCatalog: CatalogModel[] = [
        {
          id: "present-model",
          label: "Present Model",
          provider: "openai-compatible",
          model: "meta-llama/llama-3.3-70b-instruct",
          tier: "flash",
          supportsTools: true,
        },
        {
          id: "missing-model",
          label: "Missing Model",
          provider: "openai-compatible",
          model: "unlisted-vendor/unlisted-model-v1",
          tier: "pro",
          supportsTools: true,
        },
      ];

      const unlisted = await checkCatalogModels(testCatalog);
      assert.equal(requestedUrl, "https://mock.openrouter.test/api/v1/models");
      assert.deepEqual(unlisted, ["missing-model"], "Missing model should be detected as unlisted");
    } finally {
      globalThis.fetch = origFetch;
      Object.assign(config, origConfig);
    }
  });
});

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
  type CatalogModel,
} from "./catalog.js";

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
});

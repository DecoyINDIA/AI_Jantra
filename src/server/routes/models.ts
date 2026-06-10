import type { FastifyInstance } from "fastify";

import { MODEL_CATALOG, isCatalogModelAvailable } from "../../model/catalog.js";

/**
 * Exposes the server-side model catalog so the UI can render model-picker
 * buttons without hardcoding model ids. Only the fields the UI needs are
 * returned; provider-specific model strings stay server-side.
 */
export function registerModelRoutes(app: FastifyInstance): void {
  app.get("/v1/models", async () => ({
    models: MODEL_CATALOG.map((model) => ({
      id: model.id,
      label: model.label,
      tier: model.tier,
      provider: model.provider,
      supportsTools: model.supportsTools,
      available: isCatalogModelAvailable(model),
    })),
  }));
}

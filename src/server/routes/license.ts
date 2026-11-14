import type { FastifyInstance } from "fastify";
import type { LicenseManager } from "../../licensing/index.js";
import { activateLicenseBodySchema, parseWith } from "../schemas.js";

export interface LicenseRouteDeps {
  licenseManager: LicenseManager;
}

export function registerLicenseRoutes(
  app: FastifyInstance,
  deps: LicenseRouteDeps,
): void {
  // GET /v1/license - Re-verifies stored license token cryptographically on every status read.
  app.get("/v1/license", async () => {
    return deps.licenseManager.getStatus();
  });

  // POST /v1/license - Activates a license with a signed base64 token.
  app.post("/v1/license", async (request) => {
    const body = parseWith(activateLicenseBodySchema, request.body);
    return deps.licenseManager.activate(body.token);
  });
}

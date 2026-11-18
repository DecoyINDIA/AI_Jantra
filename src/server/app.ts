import fastify, { type FastifyInstance } from "fastify";

import { setAuditPublisher } from "../audit.js";
import { setGatePublisher } from "../runtime/gateEvents.js";
import { defaultAgentRegistry, type AgentRegistry } from "../agents/registry.js";
import { defaultStore, type ApiKeyStore, type ProjectStore } from "../pipeline/store.js";
import { dispatchGateEvent } from "./webhooks/dispatcher.js";
import { installApiKeyAuth, parseApiKeyRecords, type ApiKeyRecord } from "./auth/apiKeys.js";
import { runEventBus } from "./events.js";
import { CostCeilingExceededError, GateConflictError } from "../runtime/errors.js";
import { HttpError, sendHttpError } from "./errors.js";
import { installLocalSecurity } from "./security.js";
import { installIdentityRateLimit, installRateLimit } from "./rateLimit.js";
import { config } from "../config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAdminKeyRoutes } from "./routes/adminKeys.js";
import { registerAdminCredentialRoutes } from "./routes/adminCredentials.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerCompleteRoutes } from "./routes/complete.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerLicenseRoutes } from "./routes/license.js";
import { defaultLicenseManager, type LicenseManager } from "../licensing/index.js";
import { defaultLeadStore, type LeadStore } from "./leads/store.js";
import { defaultWebhookStore, type WebhookSubscriptionStore } from "./webhooks/store.js";
import { JobWorker } from "./jobs/worker.js";
import type { JobStore } from "./jobs/types.js";
import { checkCatalogModels } from "../model/catalog.js";

export interface CreateServerOptions {
  loopbackToken: string;
  mode?: "local" | "remote";
  clientId?: string;
  registry?: AgentRegistry;
  store?: ProjectStore;
  apiKeyStore?: ApiKeyStore;
  leadStore?: LeadStore;
  webhookStore?: WebhookSubscriptionStore;
  apiKeys?: ApiKeyRecord[];
  adminToken?: string;
  /** Defaults to config.edgeSharedSecret; see ApiKeyAuthOptions.edgeSecret. */
  edgeSecret?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  jobWorker?: JobWorker;
  jobPollIntervalMs?: number;
  licenseManager?: LicenseManager;
  licenseEnforcement?: boolean;
  checkCatalogModels?: boolean;
}

export interface StartedLocalApi {
  app: FastifyInstance;
  baseUrl: string;
  loopbackToken: string;
}

function isApiKeyStore(store: ProjectStore): store is ProjectStore & ApiKeyStore {
  const candidate = store as Partial<ApiKeyStore>;
  return (
    typeof candidate.createApiKey === "function" &&
    typeof candidate.getApiKeyByHash === "function" &&
    typeof candidate.listApiKeys === "function" &&
    typeof candidate.revokeApiKey === "function" &&
    typeof candidate.touchApiKeyLastUsed === "function"
  );
}

function isLeadStore(store: unknown): store is LeadStore {
  const candidate = store as Partial<LeadStore>;
  return typeof candidate?.createLead === "function" && typeof candidate?.listLeads === "function";
}

function isWebhookStore(store: unknown): store is WebhookSubscriptionStore {
  const candidate = store as Partial<WebhookSubscriptionStore>;
  return (
    typeof candidate?.list === "function" &&
    typeof candidate?.create === "function" &&
    typeof candidate?.delete === "function"
  );
}

function isJobStore(store: unknown): store is ProjectStore & JobStore {
  const candidate = store as Partial<JobStore>;
  return (
    typeof candidate?.createJob === "function" &&
    typeof candidate?.getJob === "function" &&
    typeof candidate?.claimNextJob === "function"
  );
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const mode = options.mode ?? "local";
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Behind Render/Railway in remote mode, request.ip must reflect the real
    // client (X-Forwarded-For) so the per-IP limiter throttles clients rather
    // than the shared proxy address. Trust is by peer address, not hop count:
    // forwarding headers are honoured only while the hop is an internal proxy
    // address, so request.ip is the first untrusted (real client) entry from
    // the right. `true` would trust the client-controlled LEFTMOST entry, and
    // Fastify >= 5.12 ignores numeric hop counts entirely (every visitor then
    // shares the proxy's bucket). A client connecting directly from a public
    // address cannot spoof, because its socket address is not trusted.
    trustProxy: mode === "remote" ? config.trustedProxies : false,
  });
  const clientId = options.clientId ?? "xolver";
  const registry = options.registry ?? defaultAgentRegistry;
  const store = options.store ?? defaultStore;
  const apiKeyStore = options.apiKeyStore ?? (isApiKeyStore(store) ? store : undefined);
  const leadStore = options.leadStore ?? (isLeadStore(store) ? store : defaultLeadStore);
  const webhookStore = options.webhookStore ?? (isWebhookStore(store) ? store : defaultWebhookStore);
  const licenseManager = options.licenseManager ?? defaultLicenseManager;
  const licenseEnforcement =
    options.licenseEnforcement ??
    (licenseManager.isEnforcementEnabled() || config.licenseEnforcement);

  if (licenseEnforcement) {
    app.addHook("preHandler", async (request) => {
      if (
        request.method === "GET" ||
        request.method === "HEAD" ||
        request.method === "OPTIONS"
      ) {
        return;
      }
      const path = request.url.split("?")[0]!;
      if (path === "/v1/license") {
        return;
      }
      const requiresLicense =
        path === "/v1/complete" ||
        path === "/v1/runs" ||
        path.startsWith("/v1/runs/");

      if (requiresLicense) {
        await licenseManager.assertActive("Execution");
      }
    });
  }
  const jobWorker =
    options.jobWorker ??
    (isJobStore(store)
      ? new JobWorker({
          store,
          pollIntervalMs: options.jobPollIntervalMs ?? 1000,
        })
      : undefined);
  if (jobWorker) {
    jobWorker.start();
  }

  // Baseline response headers. The API serves JSON plus one HTML export; none
  // of it should be MIME-sniffed, framed, or leak its URL (which carries run
  // IDs) via Referer. Routes may tighten these (the export adds a CSP).
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    if (!reply.hasHeader("referrer-policy")) reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.get("/health", async () => ({ status: "healthy" }));

  if (mode === "remote") {
    // Throttle before auth so unauthenticated floods and API-key brute-force
    // attempts are capped too. Because every public request shares the edge's
    // address, multiply the pre-auth limiter's effective ceiling by 10 for safety.
    installRateLimit(app, {
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax * 10,
    });
    installApiKeyAuth(app, {
      apiKeyStore,
      envRecords: options.apiKeys ?? parseApiKeyRecords(),
      edgeSecret: options.edgeSecret ?? config.edgeSharedSecret,
    });
    installIdentityRateLimit(app, {
      windowMs: config.rateLimitWindowMs,
      publicMax: config.publicVisitorRateLimitMax,
      fullMax: config.rateLimitMax,
    });
  } else {
    installLocalSecurity(app, {
      loopbackToken: options.loopbackToken,
      allowedOrigins: options.allowedOrigins,
      allowedHosts: options.allowedHosts,
    });
  }

  setAuditPublisher((entry) => runEventBus.publishAuditEntry(entry));
  // Fan human-gate transitions (awaiting_confirmation / awaiting_input) out to
  // registered webhooks so operators learn a run is waiting without the UI open.
  setGatePublisher((event) => dispatchGateEvent(event, webhookStore));

  if (options.adminToken) {
    if (!apiKeyStore) {
      throw new Error("JANTRA_ADMIN_TOKEN requires a SQLite ApiKeyStore.");
    }
    registerAdminKeyRoutes(app, { adminToken: options.adminToken, apiKeyStore });
    registerAdminCredentialRoutes(app, { adminToken: options.adminToken, store });
  }

  registerAgentRoutes(app, registry);
  registerModelRoutes(app);
  const shouldCheckCatalog =
    options.checkCatalogModels ?? (options.mode === "remote");
  if (shouldCheckCatalog) {
    void checkCatalogModels();
  }
  registerRunRoutes(app, { clientId, registry, store, jobWorker });
  registerInteractionRoutes(app, { clientId, store, jobWorker });
  registerArtifactRoutes(app, { clientId, store });
  registerAuditRoutes(app, { clientId, store });
  registerEventRoutes(app, { clientId, store });
  registerWebhookRoutes(app, { clientId, store: webhookStore });
  registerCompleteRoutes(app, { clientId, store });
  registerLeadRoutes(app, { clientId, projectStore: store, leadStore, webhookStore });
  registerCredentialRoutes(app, { clientId, store });
  registerLicenseRoutes(app, { licenseManager });

  if (config.enableLeadDeletionSweep && typeof leadStore.sweepExpiredLeads === "function") {
    try {
      leadStore.sweepExpiredLeads(config.leadRetentionDays, {
        deleteLinkedRuns: config.leadDeleteLinkedRuns,
        projectStore: store,
      });
    } catch (err) {
      console.warn("Failed to run initial lead retention sweep:", err);
    }
  }

  app.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    const isClient =
      err instanceof HttpError ||
      err instanceof GateConflictError ||
      err instanceof CostCeilingExceededError ||
      (typeof status === "number" && status < 500);
    if (!isClient) {
      console.error(
        JSON.stringify({
          level: "error",
          requestId: request.id,
          method: request.method,
          path: request.url.split("?")[0],
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      );
    }
    sendHttpError(reply, err, request.id);
  });

  app.addHook("onClose", async () => {
    jobWorker?.stop();
    setAuditPublisher(null);
    setGatePublisher(null);
  });

  return app;
}

export async function startLocalApi(options: CreateServerOptions & {
  host?: string;
  port?: number;
}): Promise<StartedLocalApi> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("Local Jantra API may only bind to 127.0.0.1 before A5.");
  }
  const app = createServer(options);
  const address = await app.listen({ host, port: options.port ?? 0 });
  return {
    app,
    baseUrl: address,
    loopbackToken: options.loopbackToken,
  };
}

export async function startRemoteApi(options: Omit<CreateServerOptions, "loopbackToken" | "mode"> & {
  host: string;
  port: number;
  apiKeys?: ApiKeyRecord[];
}): Promise<StartedLocalApi> {
  const edgeSecret = options.edgeSecret ?? config.edgeSharedSecret;
  if (!edgeSecret) {
    console.warn(
      "JANTRA_EDGE_SECRET is not set: public-scope keys (the website widget) will be refused. Set it on both the origin and the Cloudflare Worker.",
    );
  }
  const app = createServer({
    ...options,
    mode: "remote",
    loopbackToken: "",
    apiKeys: options.apiKeys,
    checkCatalogModels: options.checkCatalogModels ?? true,
  });
  const address = await app.listen({ host: options.host, port: options.port });
  return {
    app,
    baseUrl: address,
    loopbackToken: "",
  };
}

import fastify, { type FastifyInstance } from "fastify";

import { setAuditPublisher } from "../audit.js";
import { setGatePublisher } from "../runtime/gateEvents.js";
import { defaultAgentRegistry, type AgentRegistry } from "../agents/registry.js";
import { defaultStore, type ApiKeyStore, type ProjectStore } from "../pipeline/store.js";
import { dispatchGateEvent } from "./webhooks/dispatcher.js";
import { installApiKeyAuth, parseApiKeyRecords, type ApiKeyRecord } from "./auth/apiKeys.js";
import { runEventBus } from "./events.js";
import { sendHttpError } from "./errors.js";
import { installLocalSecurity } from "./security.js";
import { installRateLimit } from "./rateLimit.js";
import { config } from "../config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAdminKeyRoutes } from "./routes/adminKeys.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerCompleteRoutes } from "./routes/complete.js";
import { registerLeadRoutes } from "./routes/leads.js";

export interface CreateServerOptions {
  loopbackToken: string;
  mode?: "local" | "remote";
  clientId?: string;
  registry?: AgentRegistry;
  store?: ProjectStore;
  apiKeyStore?: ApiKeyStore;
  apiKeys?: ApiKeyRecord[];
  adminToken?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
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

export function createServer(options: CreateServerOptions): FastifyInstance {
  const mode = options.mode ?? "local";
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Behind Cloudflare/Railway in remote mode, trust the proxy so request.ip
    // reflects the real client (X-Forwarded-For) — required for the per-IP rate
    // limiter to throttle real clients rather than the shared proxy address.
    trustProxy: mode === "remote",
  });
  const clientId = options.clientId ?? "xolver";
  const registry = options.registry ?? defaultAgentRegistry;
  const store = options.store ?? defaultStore;
  const apiKeyStore = options.apiKeyStore ?? (isApiKeyStore(store) ? store : undefined);

  if (mode === "remote") {
    // Throttle before auth so unauthenticated floods and API-key brute-force
    // attempts are capped too. The loopback-only local API is not rate limited.
    installRateLimit(app, {
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
    });
    installApiKeyAuth(app, {
      apiKeyStore,
      envRecords: options.apiKeys ?? parseApiKeyRecords(),
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
  setGatePublisher((event) => dispatchGateEvent(event));

  if (options.adminToken) {
    if (!apiKeyStore) {
      throw new Error("JANTRA_ADMIN_TOKEN requires a SQLite ApiKeyStore.");
    }
    registerAdminKeyRoutes(app, { adminToken: options.adminToken, apiKeyStore });
  }

  registerAgentRoutes(app, registry);
  registerModelRoutes(app);
  registerRunRoutes(app, { clientId, registry, store });
  registerInteractionRoutes(app, { clientId, store });
  registerArtifactRoutes(app, { clientId, store });
  registerAuditRoutes(app, { clientId, store });
  registerEventRoutes(app, { clientId, store });
  registerWebhookRoutes(app, { clientId });
  registerCompleteRoutes(app, { clientId });
  registerLeadRoutes(app, { clientId });

  app.setErrorHandler((err, _request, reply) => {
    sendHttpError(reply, err);
  });

  app.addHook("onClose", async () => {
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
  const app = createServer({
    ...options,
    mode: "remote",
    loopbackToken: "",
    apiKeys: options.apiKeys,
  });
  const address = await app.listen({ host: options.host, port: options.port });
  return {
    app,
    baseUrl: address,
    loopbackToken: "",
  };
}

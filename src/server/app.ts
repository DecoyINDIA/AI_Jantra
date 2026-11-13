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
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerCompleteRoutes } from "./routes/complete.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { defaultLeadStore, type LeadStore } from "./leads/store.js";
import { defaultWebhookStore, type WebhookSubscriptionStore } from "./webhooks/store.js";

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

export function createServer(options: CreateServerOptions): FastifyInstance {
  const mode = options.mode ?? "local";
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Behind Cloudflare/Railway in remote mode, trust the proxy so request.ip
    // reflects the real client (X-Forwarded-For) — required for the per-IP rate
    // limiter to throttle real clients rather than the shared proxy address.
    // Trust exactly one hop: the platform's own reverse proxy. A boolean `true`
    // trusts an unbounded X-Forwarded-For chain and Fastify resolves request.ip
    // to the LEFTMOST entry, which is fully client-controlled — a spoofed header
    // lets a client rotate "IP" every request and bypass the rate limiter below.
    // A numeric trustProxy trusts N hops counted from the socket, i.e. only the
    // value appended by the immediately-connected, trusted proxy.
    trustProxy: mode === "remote" ? 1 : false,
  });
  const clientId = options.clientId ?? "xolver";
  const registry = options.registry ?? defaultAgentRegistry;
  const store = options.store ?? defaultStore;
  const apiKeyStore = options.apiKeyStore ?? (isApiKeyStore(store) ? store : undefined);
  const leadStore = options.leadStore ?? (isLeadStore(store) ? store : defaultLeadStore);
  const webhookStore = options.webhookStore ?? (isWebhookStore(store) ? store : defaultWebhookStore);

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
  }

  registerAgentRoutes(app, registry);
  registerModelRoutes(app);
  registerRunRoutes(app, { clientId, registry, store });
  registerInteractionRoutes(app, { clientId, store });
  registerArtifactRoutes(app, { clientId, store });
  registerAuditRoutes(app, { clientId, store });
  registerEventRoutes(app, { clientId, store });
  registerWebhookRoutes(app, { clientId, store: webhookStore });
  registerCompleteRoutes(app, { clientId, store });
  registerLeadRoutes(app, { clientId, projectStore: store, leadStore, webhookStore });

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

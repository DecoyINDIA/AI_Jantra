import fastify, { type FastifyInstance } from "fastify";

import { setAuditPublisher } from "../audit.js";
import { defaultAgentRegistry, type AgentRegistry } from "../agents/registry.js";
import { defaultStore, type ProjectStore } from "../pipeline/store.js";
import { installApiKeyAuth, parseApiKeyRecords, type ApiKeyRecord } from "./auth/apiKeys.js";
import { runEventBus } from "./events.js";
import { sendHttpError } from "./errors.js";
import { installLocalSecurity } from "./security.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerRunRoutes } from "./routes/runs.js";

export interface CreateServerOptions {
  loopbackToken: string;
  mode?: "local" | "remote";
  clientId?: string;
  registry?: AgentRegistry;
  store?: ProjectStore;
  apiKeys?: ApiKeyRecord[];
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

export interface StartedLocalApi {
  app: FastifyInstance;
  baseUrl: string;
  loopbackToken: string;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });
  const clientId = options.clientId ?? "xolver";
  const registry = options.registry ?? defaultAgentRegistry;
  const store = options.store ?? defaultStore;

  if ((options.mode ?? "local") === "remote") {
    installApiKeyAuth(app, options.apiKeys ?? parseApiKeyRecords());
  } else {
    installLocalSecurity(app, {
      loopbackToken: options.loopbackToken,
      allowedOrigins: options.allowedOrigins,
      allowedHosts: options.allowedHosts,
    });
  }

  setAuditPublisher((entry) => runEventBus.publishAuditEntry(entry));

  registerAgentRoutes(app, registry);
  registerRunRoutes(app, { clientId, registry, store });
  registerInteractionRoutes(app, { clientId });
  registerArtifactRoutes(app, { clientId });
  registerAuditRoutes(app, { clientId });
  registerEventRoutes(app, { clientId });

  app.setErrorHandler((err, _request, reply) => {
    sendHttpError(reply, err);
  });

  app.addHook("onClose", async () => {
    setAuditPublisher(null);
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

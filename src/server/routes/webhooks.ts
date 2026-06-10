import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { notFound } from "../errors.js";
import { parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import {
  defaultWebhookStore,
  type WebhookSubscriptionStore,
} from "../webhooks/store.js";

const GATE_EVENT_TYPES = ["run.awaiting_confirmation", "run.awaiting_input"] as const;

const createWebhookBodySchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(8).max(256).optional(),
  // Empty/omitted → subscribe to all gate events.
  events: z.array(z.enum(GATE_EVENT_TYPES)).max(GATE_EVENT_TYPES.length).optional(),
});

const webhookParamsSchema = z.object({
  id: z.string().min(1).max(96),
});

interface WebhookRouteDeps {
  clientId: string;
  store?: WebhookSubscriptionStore;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const store = deps.store ?? defaultWebhookStore;

  app.post("/v1/webhooks", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createWebhookBodySchema, request.body);
    const subscription = store.create({
      id: randomUUID(),
      clientId,
      url: body.url,
      secret: body.secret,
      events: body.events ?? [],
      createdAt: new Date().toISOString(),
    });
    // Never echo the secret back.
    const { secret: _secret, ...safe } = subscription;
    return { subscription: { ...safe, hasSecret: Boolean(subscription.secret) } };
  });

  app.get("/v1/webhooks", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    return {
      subscriptions: store.list(clientId).map(({ secret, ...rest }) => ({
        ...rest,
        hasSecret: Boolean(secret),
      })),
    };
  });

  app.delete("/v1/webhooks/:id", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(webhookParamsSchema, request.params);
    const deleted = store.delete(clientId, params.id);
    if (!deleted) throw notFound(`Webhook subscription ${params.id} was not found.`);
    return { deleted: true };
  });
}

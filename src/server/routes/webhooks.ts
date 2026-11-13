import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { notFound, HttpError } from "../errors.js";
import { parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import {
  defaultWebhookStore,
  type WebhookSubscriptionStore,
} from "../webhooks/store.js";
import { assertPublicWebhookUrl } from "../webhooks/urlGuard.js";

export const WEBHOOK_EVENT_TYPES = [
  "run.awaiting_confirmation",
  "run.awaiting_input",
  "run.intake_completed",
  "lead.created",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const createWebhookBodySchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(8).max(256).optional(),
  // Empty/omitted → subscribe to all events.
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).optional(),
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
    try {
      await assertPublicWebhookUrl(body.url);
    } catch (err) {
      throw new HttpError(400, "invalid_webhook_url", err instanceof Error ? err.message : String(err));
    }
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

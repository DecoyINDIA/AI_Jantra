import { randomUUID } from "node:crypto";

import type { GateEvent } from "../../runtime/gateEvents.js";
import { deliverWebhook } from "./delivery.js";
import { defaultWebhookStore, type WebhookSubscriptionStore } from "./store.js";
import type { WebhookEvent } from "./types.js";

export interface WebhookDispatchEvent {
  clientId: string;
  type: string;
  runId?: string;
  payload: Record<string, unknown>;
}

/**
 * Fan an event out to every matching subscription for the client.
 * Fire-and-forget: delivery happens off the request path and failures are
 * logged, never propagated — a down webhook endpoint must not break a run or request.
 */
export function dispatchWebhookEvent(
  event: WebhookDispatchEvent,
  store: WebhookSubscriptionStore = defaultWebhookStore,
): void {
  let subscriptions;
  try {
    subscriptions = store.list(event.clientId);
  } catch (err) {
    console.warn(`[jantra] failed to load webhook subscriptions: ${String(err)}`);
    return;
  }

  const matching = subscriptions.filter(
    (subscription) =>
      subscription.events.length === 0 || subscription.events.includes(event.type),
  );
  if (!matching.length) return;

  const payload: WebhookEvent = {
    id: randomUUID(),
    clientId: event.clientId,
    type: event.type,
    runId: event.runId,
    createdAt: new Date().toISOString(),
    payload: event.payload,
  };

  for (const subscription of matching) {
    void deliverWebhook(subscription, payload).catch((err) => {
      console.warn(
        `[jantra] webhook delivery to ${subscription.id} failed: ${String(err)}`,
      );
    });
  }
}

/**
 * Fan a gate transition out to every matching subscription for the client.
 */
export function dispatchGateEvent(
  event: GateEvent,
  store: WebhookSubscriptionStore = defaultWebhookStore,
): void {
  dispatchWebhookEvent(
    {
      clientId: event.clientId,
      type: event.type,
      runId: event.runId,
      payload: {
        stageId: event.stageId,
        interactionId: event.interactionId,
      },
    },
    store,
  );
}

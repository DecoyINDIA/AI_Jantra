import { createHmac } from "node:crypto";

import type { WebhookEvent, WebhookSubscription } from "./types.js";

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function deliverWebhook(
  subscription: WebhookSubscription,
  event: WebhookEvent,
  attempts = 3,
): Promise<void> {
  const body = JSON.stringify(event);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Jantra-Event": event.type,
        ...(subscription.secret
          ? { "X-Jantra-Signature": signature(subscription.secret, body) }
          : {}),
      },
      body,
    });
    if (response.ok) return;
    if (attempt === attempts) {
      throw new Error(`Webhook delivery failed with ${response.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
}

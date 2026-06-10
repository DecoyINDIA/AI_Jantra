import { createHmac } from "node:crypto";

import type { WebhookEvent, WebhookSubscription } from "./types.js";

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** 4xx other than 429 will not succeed on retry — stop immediately. */
function isNonRetryableStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return 250 * attempt;
}

export async function deliverWebhook(
  subscription: WebhookSubscription,
  event: WebhookEvent,
  attempts = 3,
): Promise<void> {
  const body = JSON.stringify(event);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
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
      if (isNonRetryableStatus(response.status)) {
        throw new Error(`Webhook delivery failed with non-retryable ${response.status}.`);
      }
      lastError = new Error(`Webhook delivery failed with ${response.status}.`);
      if (attempt === attempts) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    } catch (err) {
      // Network-level failure (DNS, connection reset). Retry transient errors;
      // a thrown non-retryable status above re-throws here and stops.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("non-retryable") || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError ?? new Error("Webhook delivery failed.");
}

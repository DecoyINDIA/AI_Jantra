import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signing.
 *
 * `X-Jantra-Signature` (v1) is HMAC-SHA256 over the raw body. It is kept for
 * existing receivers but cannot stop replay: a captured request stays valid
 * forever. `X-Jantra-Signature-V2` binds the body to `X-Jantra-Timestamp`
 * (HMAC over `${timestamp}.${body}`), so receivers can reject stale or
 * replayed deliveries with `verifyWebhookSignature`.
 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function webhookSignatureHeaders(
  secret: string,
  body: string,
  nowMs = Date.now(),
): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    "X-Jantra-Signature": hmacHex(secret, body),
    "X-Jantra-Timestamp": timestamp,
    "X-Jantra-Signature-V2": hmacHex(secret, `${timestamp}.${body}`),
  };
}

function safeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

/**
 * Receiver-side check for V2 signatures. Exported so integrators (and the
 * regression suite) verify exactly the scheme the sender uses.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  headers: { timestamp?: string | null; signatureV2?: string | null },
  options: { nowMs?: number; toleranceSeconds?: number } = {},
): WebhookVerification {
  const { timestamp, signatureV2 } = headers;
  if (!timestamp || !signatureV2 || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "missing_headers" };
  }
  const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = hmacHex(secret, `${timestamp}.${body}`);
  if (!safeHexEqual(expected, signatureV2.toLowerCase())) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

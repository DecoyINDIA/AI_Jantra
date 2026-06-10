import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { config } from "../../config.js";
import type { WebhookSubscription } from "./types.js";

/**
 * JSON-backed, per-client store of webhook subscriptions. Kept deliberately
 * small and file-based to match the JSON project store; a multi-process
 * deployment should move this to the transactional store alongside projects.
 */
function clientWebhookFile(clientId: string): string {
  return join(config.projectDir, clientId, "webhooks.json");
}

function readAll(clientId: string): WebhookSubscription[] {
  const file = clientWebhookFile(clientId);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as WebhookSubscription[]) : [];
  } catch {
    return [];
  }
}

function writeAll(clientId: string, subscriptions: WebhookSubscription[]): void {
  const file = clientWebhookFile(clientId);
  mkdirSync(join(config.projectDir, clientId), { recursive: true });
  // Atomic write: temp + rename so a crash mid-write cannot corrupt the file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(subscriptions, null, 2), "utf8");
  renameSync(tmp, file);
}

export interface WebhookSubscriptionStore {
  list(clientId: string): WebhookSubscription[];
  create(subscription: WebhookSubscription): WebhookSubscription;
  delete(clientId: string, id: string): boolean;
}

export class JsonWebhookSubscriptionStore implements WebhookSubscriptionStore {
  list(clientId: string): WebhookSubscription[] {
    return readAll(clientId);
  }

  create(subscription: WebhookSubscription): WebhookSubscription {
    const existing = readAll(subscription.clientId);
    existing.push(subscription);
    writeAll(subscription.clientId, existing);
    return subscription;
  }

  delete(clientId: string, id: string): boolean {
    const existing = readAll(clientId);
    const next = existing.filter((subscription) => subscription.id !== id);
    if (next.length === existing.length) return false;
    writeAll(clientId, next);
    return true;
  }
}

export const defaultWebhookStore: WebhookSubscriptionStore =
  new JsonWebhookSubscriptionStore();

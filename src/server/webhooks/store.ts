import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { config } from "../../config.js";
import { assertSafePathSegment } from "../../pipeline/store.js";
import type { WebhookSubscription } from "./types.js";

/**
 * JSON-backed, per-client store of webhook subscriptions. Kept deliberately
 * small and file-based to match the JSON project store; a multi-process
 * deployment should move this to the transactional store alongside projects.
 */
function clientWebhookFile(clientId: string): string {
  return join(config.projectDir, assertSafePathSegment(clientId, "clientId"), "webhooks.json");
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
  mkdirSync(join(config.projectDir, assertSafePathSegment(clientId, "clientId")), { recursive: true });
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

interface WebhookSubscriptionRow {
  id: string;
  client_id: string;
  url: string;
  secret: string | null;
  events: string;
  created_at: string;
}

function toWebhookSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  let events: WebhookSubscription["events"] = [];
  try {
    const parsed = JSON.parse(row.events);
    if (Array.isArray(parsed)) events = parsed;
  } catch {}
  return {
    id: row.id,
    clientId: row.client_id,
    url: row.url,
    secret: row.secret ?? undefined,
    events,
    createdAt: row.created_at,
  };
}

export class SqliteWebhookSubscriptionStore implements WebhookSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  list(clientId: string): WebhookSubscription[] {
    const rows = this.db
      .prepare(
        "select * from webhook_subscriptions where client_id = ? order by created_at asc",
      )
      .all(clientId) as WebhookSubscriptionRow[];
    return rows.map(toWebhookSubscription);
  }

  create(subscription: WebhookSubscription): WebhookSubscription {
    this.db
      .prepare(
        `insert into webhook_subscriptions (id, client_id, url, secret, events, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subscription.id,
        subscription.clientId,
        subscription.url,
        subscription.secret ?? null,
        JSON.stringify(subscription.events ?? []),
        subscription.createdAt,
      );
    return subscription;
  }

  delete(clientId: string, id: string): boolean {
    const result = this.db
      .prepare("delete from webhook_subscriptions where client_id = ? and id = ?")
      .run(clientId, id);
    return result.changes > 0;
  }
}

export const defaultWebhookStore: WebhookSubscriptionStore =
  new JsonWebhookSubscriptionStore();

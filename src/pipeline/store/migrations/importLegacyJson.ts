import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { config } from "../../../config.js";
import type { LeadRecord } from "../../../server/leads/store.js";
import type { WebhookSubscription } from "../../../server/webhooks/types.js";

export interface ImportResult {
  leadsImported: number;
  webhooksImported: number;
}

export function importLegacyJsonData(
  db: Database.Database,
  options?: { leadDir?: string; projectDir?: string },
): ImportResult {
  const leadDir = options?.leadDir ?? config.leadDir;
  const projectDir = options?.projectDir ?? config.projectDir;

  let leadsImported = 0;
  let webhooksImported = 0;

  // 1. Import leads from leadDir/<clientId>/*.json
  if (existsSync(leadDir)) {
    try {
      const clientEntries = readdirSync(leadDir, { withFileTypes: true });
      const insertLead = db.prepare(`
        insert or ignore into leads (
          id, client_id, user_sub, name, email, phone, idea, source, run_id, created_at, deleted_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
      `);

      for (const clientEntry of clientEntries) {
        if (clientEntry.isDirectory() && !clientEntry.name.endsWith(".imported")) {
          const clientPath = join(leadDir, clientEntry.name);
          const files = readdirSync(clientPath).filter((f) => f.endsWith(".json"));

          for (const file of files) {
            try {
              const content = readFileSync(join(clientPath, file), "utf8");
              const record = JSON.parse(content) as LeadRecord;
              if (record.id && record.clientId) {
                insertLead.run(
                  record.id,
                  record.clientId,
                  record.userSub ?? null,
                  record.name ?? "",
                  record.email ?? "",
                  record.phone ?? null,
                  record.idea ?? "",
                  record.source ?? "unknown",
                  record.runId ?? null,
                  record.createdAt ?? new Date().toISOString(),
                );
                leadsImported++;
              }
            } catch (err) {
              console.warn(`Failed to parse legacy lead JSON ${file}:`, err);
            }
          }

          // Rename client folder to .imported so it is never reprocessed
          const importedPath = join(leadDir, `${clientEntry.name}.imported`);
          try {
            if (!existsSync(importedPath)) {
              renameSync(clientPath, importedPath);
            } else {
              renameSync(clientPath, `${importedPath}.${Date.now()}`);
            }
          } catch (renameErr) {
            console.warn(`Failed to rename imported lead directory ${clientPath}:`, renameErr);
          }
        }
      }
    } catch (err) {
      console.warn("Failed scanning legacy leadDir for import:", err);
    }
  }

  // 2. Import webhooks from projectDir/<clientId>/webhooks.json
  if (existsSync(projectDir)) {
    try {
      const clientEntries = readdirSync(projectDir, { withFileTypes: true });
      const insertWebhook = db.prepare(`
        insert or ignore into webhook_subscriptions (
          id, client_id, url, secret, events, created_at
        ) values (?, ?, ?, ?, ?, ?)
      `);

      for (const clientEntry of clientEntries) {
        if (clientEntry.isDirectory()) {
          const webhookFile = join(projectDir, clientEntry.name, "webhooks.json");
          if (existsSync(webhookFile)) {
            try {
              const content = readFileSync(webhookFile, "utf8");
              const subscriptions = JSON.parse(content) as WebhookSubscription[];
              if (Array.isArray(subscriptions)) {
                for (const sub of subscriptions) {
                  if (sub.id && sub.clientId && sub.url) {
                    insertWebhook.run(
                      sub.id,
                      sub.clientId,
                      sub.url,
                      sub.secret ?? null,
                      JSON.stringify(sub.events ?? []),
                      sub.createdAt ?? new Date().toISOString(),
                    );
                    webhooksImported++;
                  }
                }
              }

              // Rename webhooks.json to webhooks.json.imported
              renameSync(webhookFile, `${webhookFile}.imported`);
            } catch (err) {
              console.warn(`Failed to import legacy webhooks from ${webhookFile}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn("Failed scanning legacy projectDir for webhooks import:", err);
    }
  }

  return { leadsImported, webhooksImported };
}

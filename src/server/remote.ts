// Trigger Railway rebuild: force registration of firebnb-concierge agent definition
import { requireApiKey } from "../config.js";
import { SqliteProjectStore } from "../pipeline/store/sqlite.js";
import { startRemoteApi } from "./app.js";
import { parseApiKeyRecords } from "./auth/apiKeys.js";

/**
 * Public/remote Jantra API entry point.
 *
 * This binds the API-key-authenticated server so a hosted deployment can serve
 * partner traffic. It is intended to run as a PRIVATE origin behind a public
 * edge (e.g. a Cloudflare Worker) that holds the API key, enforces the Origin
 * allowlist, and rate-limits per IP. The browser never talks to this process
 * directly, so CORS is owned by the edge, not here.
 *
 * Required env:
 *   GEMINI_API_KEY            the model key (unless JANTRA_PROVIDER=mock)
 *   JANTRA_REMOTE_API_KEYS    comma list of key:clientId[:subject] records
 * Optional env:
 *   JANTRA_SERVER_HOST        bind host (default 0.0.0.0 for container hosting)
 *   JANTRA_SERVER_PORT        bind port (default 4317)
 *   JANTRA_PROJECT_DIR        SQLite project store (persist on a disk volume)
 *   JANTRA_AUDIT_DIR          audit trail dir (persist on a disk volume)
 */
requireApiKey();

const apiKeys = parseApiKeyRecords();
const host = process.env.JANTRA_SERVER_HOST ?? "0.0.0.0";
const port = process.env.JANTRA_SERVER_PORT ? Number(process.env.JANTRA_SERVER_PORT) : 4317;
const store = new SqliteProjectStore();

const started = await startRemoteApi({
  host,
  port,
  apiKeys,
  store,
  apiKeyStore: store,
  adminToken: process.env.JANTRA_ADMIN_TOKEN,
});

console.log(`Jantra remote API listening at ${started.baseUrl}`);
console.log(`Loaded ${apiKeys.length} API key record(s).`);

const shutdown = async () => {
  await started.app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

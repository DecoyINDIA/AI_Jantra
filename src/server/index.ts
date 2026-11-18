import { generateLoopbackToken } from "./security.js";
import { startLocalApi } from "./app.js";
import { config, requireApiKey } from "../config.js";
import { SqliteProjectStore } from "../pipeline/store/sqlite.js";

requireApiKey();

const token = config.loopbackToken || generateLoopbackToken();
const port = config.serverPort;
const allowedOrigins = config.localAllowedOrigins;
const store = config.adminToken ? new SqliteProjectStore() : undefined;

const started = await startLocalApi({
  host: "127.0.0.1",
  port,
  loopbackToken: token,
  clientId: config.defaultClientId,
  store,
  apiKeyStore: store,
  adminToken: config.adminToken || undefined,
  allowedOrigins: allowedOrigins.length ? allowedOrigins : undefined,
});

console.log(`Jantra local API listening at ${started.baseUrl}`);
console.log(`Loopback token: ${started.loopbackToken}`);

const shutdown = async () => {
  await started.app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

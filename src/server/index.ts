import { generateLoopbackToken } from "./security.js";
import { startLocalApi } from "./app.js";

const token = process.env.JANTRA_LOOPBACK_TOKEN ?? generateLoopbackToken();
const port = process.env.JANTRA_SERVER_PORT
  ? Number(process.env.JANTRA_SERVER_PORT)
  : 4317;

const started = await startLocalApi({
  host: "127.0.0.1",
  port,
  loopbackToken: token,
  clientId: process.env.JANTRA_CLIENT_ID ?? "xolver",
});

console.log(`Jantra local API listening at ${started.baseUrl}`);
console.log(`Loopback token: ${started.loopbackToken}`);

const shutdown = async () => {
  await started.app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

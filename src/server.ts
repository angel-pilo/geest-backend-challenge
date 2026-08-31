import { createApp } from "./app";
import { getEnv } from "./config/env";
import { closePool } from "./database/pool";

const env = getEnv();
const app = createApp();

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.info(`GEEST API listening on port ${env.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`Received ${signal}; shutting down`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

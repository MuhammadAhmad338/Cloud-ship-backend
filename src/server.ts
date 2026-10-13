import { app } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.info(`CloudShip API listening on port ${config.PORT}`);
});

async function shutdown(signal: string) {
  console.info(`${signal} received, shutting down`);
  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown failed", error);
      process.exitCode = 1;
    }
    await pool.end();
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
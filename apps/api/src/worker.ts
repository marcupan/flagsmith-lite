/**
 * Standalone webhook delivery worker.
 *
 * Polls for pending/retrying deliveries and processes them.
 * Runs as a separate process from the API server — same codebase,
 * different entry point. This is the pattern Docker Compose uses:
 *   api:    pnpm exec tsx src/index.ts
 *   worker: pnpm exec tsx src/worker.ts
 */

import pino from "pino";

import { createDb } from "./db.js";
import { processPendingDeliveries } from "./delivery-service.js";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({
  service: "flagsmith-worker",
});

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Required env var "DATABASE_URL" is not set');
  }

  const db = createDb(databaseUrl);

  logger.info({ pollInterval: POLL_INTERVAL_MS }, "Worker started");

  // Graceful shutdown
  let running = true;

  const shutdown = () => {
    logger.info("Shutting down worker...");
    running = false;
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const processed = await processPendingDeliveries(db, logger);

      if (processed > 0) {
        logger.info({ processed }, "Delivery batch completed");
      }
    } catch (err) {
      logger.error({ err }, "Worker poll cycle failed");
    }

    // Wait before the next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  logger.info("Worker stopped");
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, "Worker failed to start");
  process.exit(1);
});

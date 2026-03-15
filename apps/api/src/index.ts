import fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDb, type Db } from "./db.js";
import { createCache, type Cache } from "./cache.js";
import { authPlugin } from "./plugins/auth.js";
import { healthRoute } from "./routes/health.js";
import { flagsRoutes } from "./routes/flags.js";
import { evaluateRoutes } from "./routes/evaluate.js";

const isProd = process.env.NODE_ENV === "production";

export interface BuildServerOptions {
  db: Db;
  cache: Cache | null;
  apiKey: string;
  rateLimit?: boolean;
}

export async function buildServer(opts: BuildServerOptions) {
  const server = fastify({
    logger: { level: isProd ? "info" : "debug" },
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  });

  server.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  await server.register(cors, {
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  });

  await server.register(helmet, {
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  if (opts.rateLimit !== false) {
    await server.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      errorResponseBuilder: (_req, context) => ({
        code: "RATE_LIMIT_EXCEEDED",
        message: `Rate limit exceeded — retry after ${Math.ceil(context.ttl / 1000)}s`,
      }),
    });
  }

  // Decorate with db and cache so route plugins can access them
  server.decorate("db", opts.db);
  server.decorate("cache", opts.cache);

  server.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled server error");
    } else {
      request.log.warn({ err: error }, "Client error");
    }

    void reply.status(statusCode).send({
      code:
        (error as { code?: string }).code ??
        (statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR"),
      message: statusCode >= 500 ? "Internal server error" : (error as Error).message,
      requestId: request.id,
    });
  });

  // Public routes — no auth required
  await server.register(healthRoute);
  await server.register(evaluateRoutes, { prefix: "/evaluate" });

  // Protected routes — require API key
  await server.register(async (scope) => {
    await scope.register(authPlugin, { apiKey: opts.apiKey });
    await scope.register(flagsRoutes, { prefix: "/flags" });
  });

  return server;
}

async function start() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Required env var "DATABASE_URL" is not set');
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('Required env var "API_KEY" is not set');
  }

  const redisUrl = process.env.REDIS_URL;
  const cache = redisUrl ? createCache(redisUrl) : null;

  const db = createDb(databaseUrl);

  const server = await buildServer({ db, cache, apiKey });
  const port = Number(process.env.PORT ?? 3000);

  try {
    await server.listen({ port, host: "0.0.0.0" });
  } catch (error) {
    server.log.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

// Only start when this file is the entry point (not when imported by tests)
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  void start();
}

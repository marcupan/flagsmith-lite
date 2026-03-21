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
    // Accept caller-supplied ID only if it looks like a safe identifier (UUID or
    // alphanumeric slug ≤ 64 chars). Arbitrary values are rejected to prevent log
    // injection — newlines or ANSI codes in IDs can forge entries in aggregators.
    genReqId: (req) => {
      const id = req.headers["x-request-id"];

      if (typeof id === "string" && /^[\w-]{1,64}$/.test(id)) {
        return id;
      }

      return randomUUID();
    },
  });

  server.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

  if (corsOrigin === "*") {
    throw new Error("CORS_ORIGIN=* is not permitted — set a specific origin");
  }

  await server.register(cors, { origin: corsOrigin });

  // crossOriginResourcePolicy defaults to "same-origin" (secure).
  // The CORS plugin already adds Access-Control-Allow-Origin for allowed origins;
  // there is no need to weaken CORP to "cross-origin" for a JSON API.
  await server.register(helmet);

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

  // Health check — unversioned (infrastructure, not business API)
  await server.register(healthRoute);

  // API v1 — all business routes under /api/v1/
  await server.register(
    async (v1) => {
      // Public routes — no auth required
      await v1.register(evaluateRoutes, { prefix: "/evaluate" });

      // Protected routes — require an API key
      await v1.register(async (authed) => {
        await authed.register(authPlugin, { apiKey: opts.apiKey });
        await authed.register(flagsRoutes, { prefix: "/flags" });
      });
    },
    { prefix: "/api/v1" },
  );

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

  if (isProd && apiKey === "change-me-in-production") {
    throw new Error(
      "API_KEY must be changed from the default example value before running in production",
    );
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

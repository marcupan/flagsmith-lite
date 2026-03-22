import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { FlagKey, Timestamp, type EvaluateResponse } from "@project/shared";
import { flagNotFound } from "../errors.js";
import { flags } from "../schema.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const CACHE_TTL_SECONDS = 30;

export const evaluateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { key: string }; Reply: EvaluateResponse }>("/:key", {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
    handler: async (request) => {
      const { key } = request.params;
      // Validate + brand the key early — rejects malformed keys before DB hit
      const flagKey = FlagKey(key);

      // Try Redis cache first
      if (fastify.cache) {
        try {
          const cached = await fastify.cache.get(`flag:${flagKey}`);

          if (cached !== null) {
            return {
              key: flagKey,
              enabled: cached === "1",
              evaluatedAt: Timestamp(),
              source: "cache",
            } satisfies EvaluateResponse;
          }
        } catch (err) {
          // Cache miss or Redis error: fall through to database
          // Log as warn, not error — the system degrades gracefully
          request.log.warn({ err }, "Redis unavailable, falling back to DB");
        }
      }

      // Database fallback (also used when cache is disabled)
      const row = await fastify.db.query.flags.findFirst({
        where: eq(flags.key, flagKey),
      });

      if (!row) {
        throw flagNotFound(flagKey);
      }

      // Populate cache for next request
      if (fastify.cache) {
        await fastify.cache
          .set(`flag:${flagKey}`, row.enabled ? "1" : "0", "EX", CACHE_TTL_SECONDS)
          .catch((err: Error) => request.log.warn({ err }, "Cache write failed"));
      }

      return {
        key: flagKey,
        enabled: row.enabled,
        evaluatedAt: Timestamp(),
        source: "database",
      } satisfies EvaluateResponse;
    },
  });
};

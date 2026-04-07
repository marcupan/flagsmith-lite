import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { FlagKey, Timestamp, type EvaluateResponse } from "@project/shared";
import { flagNotFound } from "../errors.js";
import { flags } from "../schema.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";
import { flagEvaluations } from "../metrics.js";
import { evaluateTargeting } from "../targeting.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const CACHE_TTL_SECONDS = 30;

/**
 * Cache key format for flags with targeting data.
 * Stores JSON: { enabled, rolloutPercentage }
 * Previous format stored "1"/"0" — we detect legacy format and fall through to DB.
 */
function flagCacheKey(key: string): string {
  return `flag:${key}`;
}

interface CachedFlag {
  enabled: boolean;
  rolloutPercentage: number;
}

function parseCached(raw: string): CachedFlag | null {
  // Legacy format: "1" or "0" (pre-targeting) — treat as cache miss
  if (raw === "1" || raw === "0") return null;

  try {
    const parsed = JSON.parse(raw) as CachedFlag;

    if (typeof parsed.enabled === "boolean" && typeof parsed.rolloutPercentage === "number") {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

export const evaluateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { key: string };
    Querystring: { userId?: string };
    Reply: EvaluateResponse;
  }>("/:key", {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
    schema: {
      querystring: {
        type: "object",
        properties: {
          userId: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    handler: async (request) => {
      const { key } = request.params;
      const { userId } = request.query;
      // Validate + brand the key early — rejects malformed keys before DB hit
      const flagKey = FlagKey(key);

      // Try Redis cache first
      if (fastify.cache) {
        try {
          const raw = await fastify.cache.get(flagCacheKey(flagKey));

          if (raw !== null) {
            const cached = parseCached(raw);

            if (cached) {
              flagEvaluations.inc({ source: "cache" });

              const result = evaluateTargeting({
                flagEnabled: cached.enabled,
                rolloutPercentage: cached.rolloutPercentage,
                flagKey,
                userId,
              });

              return {
                key: flagKey,
                enabled: result.enabled,
                reason: result.reason,
                evaluatedAt: Timestamp(),
                source: "cache",
              } satisfies EvaluateResponse;
            }
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

      // Populate cache for next request (store both enabled + rolloutPercentage)
      if (fastify.cache) {
        const cacheValue = JSON.stringify({
          enabled: row.enabled,
          rolloutPercentage: row.rolloutPercentage,
        } satisfies CachedFlag);

        await fastify.cache
          .set(flagCacheKey(flagKey), cacheValue, "EX", CACHE_TTL_SECONDS)
          .catch((err: Error) => request.log.warn({ err }, "Cache write failed"));
      }

      flagEvaluations.inc({ source: "database" });

      const result = evaluateTargeting({
        flagEnabled: row.enabled,
        rolloutPercentage: row.rolloutPercentage,
        flagKey,
        userId,
      });

      return {
        key: flagKey,
        enabled: result.enabled,
        reason: result.reason,
        evaluatedAt: Timestamp(),
        source: "database",
      } satisfies EvaluateResponse;
    },
  });
};

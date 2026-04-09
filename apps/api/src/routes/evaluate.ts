import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  FlagKey,
  Timestamp,
  isEnvironment,
  type Environment,
  type EvaluateResponse,
  type EvaluateValueSource,
} from "@project/shared";
import { flagNotFound } from "../errors.js";
import { flags, flagOverrides } from "../schema.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";
import { flagEvaluations, flagEvaluationsByKey } from "../metrics.js";
import { evaluateTargeting } from "../targeting.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const CACHE_TTL_SECONDS = 30;

/**
 * Cache stores the resolved config for a (flag, environment) pair.
 * Format: JSON { enabled, rolloutPercentage, valueSource }
 */
interface CachedFlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  valueSource: EvaluateValueSource;
}

function parseCached(raw: string): CachedFlagConfig | null {
  // Legacy format: "1" or "0" (pre-targeting) — treat as cache miss
  if (raw === "1" || raw === "0") return null;

  try {
    const parsed = JSON.parse(raw) as CachedFlagConfig;

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
    Querystring: { userId?: string; env?: string };
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
          env: { type: "string", minLength: 1, maxLength: 50 },
        },
      },
    },
    handler: async (request) => {
      const { key } = request.params;
      const { userId } = request.query;
      const flagKey = FlagKey(key);

      // Default to production when no env specified (backward compatible)
      const env: Environment =
        request.query.env && isEnvironment(request.query.env) ? request.query.env : "production";

      // Cache key includes environment
      const cacheKey = `flag:${env}:${flagKey}`;

      // Try Redis cache first
      if (fastify.cache) {
        try {
          const raw = await fastify.cache.get(cacheKey);

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

              flagEvaluationsByKey.inc({
                flag_key: flagKey,
                result: result.enabled ? "enabled" : "disabled",
                source: cached.valueSource,
              });

              return {
                key: flagKey,
                enabled: result.enabled,
                reason: result.reason,
                environment: env,
                valueSource: cached.valueSource,
                evaluatedAt: Timestamp(),
                source: "cache",
              } satisfies EvaluateResponse;
            }
          }
        } catch (err) {
          request.log.warn({ err }, "Redis unavailable, falling back to DB");
        }
      }

      // Database: fetch flag + check for environment override
      const flag = await fastify.db.query.flags.findFirst({
        where: eq(flags.key, flagKey),
      });

      if (!flag) {
        throw flagNotFound(flagKey);
      }

      // Check for per-environment override
      const override = await fastify.db.query.flagOverrides.findFirst({
        where: and(eq(flagOverrides.flagId, flag.id), eq(flagOverrides.environment, env)),
      });

      // Resolve: override wins, else flag default
      const resolvedEnabled = override ? override.enabled : flag.enabled;
      const resolvedRollout = override ? override.rolloutPercentage : flag.rolloutPercentage;
      const valueSource: EvaluateValueSource = override ? "override" : "default";

      // Populate cache with resolved config
      if (fastify.cache) {
        const cacheValue = JSON.stringify({
          enabled: resolvedEnabled,
          rolloutPercentage: resolvedRollout,
          valueSource,
        } satisfies CachedFlagConfig);

        await fastify.cache
          .set(cacheKey, cacheValue, "EX", CACHE_TTL_SECONDS)
          .catch((err: Error) => request.log.warn({ err }, "Cache write failed"));
      }

      flagEvaluations.inc({ source: "database" });

      const result = evaluateTargeting({
        flagEnabled: resolvedEnabled,
        rolloutPercentage: resolvedRollout,
        flagKey,
        userId,
      });

      flagEvaluationsByKey.inc({
        flag_key: flagKey,
        result: result.enabled ? "enabled" : "disabled",
        source: valueSource,
      });

      return {
        key: flagKey,
        enabled: result.enabled,
        reason: result.reason,
        environment: env,
        valueSource,
        evaluatedAt: Timestamp(),
        source: "database",
      } satisfies EvaluateResponse;
    },
  });
};

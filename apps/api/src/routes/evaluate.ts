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
import { flags, flagOverrides, experiments } from "../schema.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";
import { experimentEvaluations, flagEvaluations, flagEvaluationsByKey } from "../metrics.js";
import { evaluateTargeting } from "../targeting.js";
import { assignCohort, cohortEnabled } from "../experiments.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const CACHE_TTL_SECONDS = 30;

/**
 * Cache stores the resolved config for a (flag, environment) pair.
 * Format: JSON { enabled, rolloutPercentage, valueSource, experiment? }
 *
 * When a running experiment exists, its minimal config is embedded in the
 * cached payload so evaluate can assign cohorts without a second DB round-trip.
 */
interface CachedExperiment {
  id: number;
  controlPercentage: number;
  variantPercentage: number;
}

interface CachedFlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  valueSource: EvaluateValueSource;
  experiment?: CachedExperiment | null;
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

/**
 * Build the evaluate response, applying either experiment cohort assignment
 * or plain percentage targeting. Pure function: no I/O, no metric side-effects
 * except the per-key counter which is incremented here for consistency
 * between cache and DB paths.
 */
function buildResponse(opts: {
  flagKey: ReturnType<typeof FlagKey>;
  env: Environment;
  userId: string | undefined;
  enabled: boolean;
  rolloutPercentage: number;
  valueSource: EvaluateValueSource;
  experiment: CachedExperiment | null;
  source: "cache" | "database";
}): EvaluateResponse {
  // When a running experiment is attached AND the caller supplied a userId,
  // cohort assignment overrides percentage targeting. Without userId we fall
  // back to normal targeting — we can't deterministically assign an anonymous
  // session to a cohort, and randomising it would break reproducibility.
  if (opts.experiment && opts.userId) {
    const cohort = assignCohort({
      flagKey: opts.flagKey,
      userId: opts.userId,
      controlPercentage: opts.experiment.controlPercentage,
      variantPercentage: opts.experiment.variantPercentage,
    });

    // Experiment serves only while the flag is enabled — a disabled flag
    // short-circuits to false regardless of cohort (safety guard).
    const enabled = opts.enabled && cohortEnabled(cohort);

    experimentEvaluations.inc({ experiment_id: String(opts.experiment.id), cohort });
    flagEvaluationsByKey.inc({
      flag_key: opts.flagKey,
      result: enabled ? "enabled" : "disabled",
      source: opts.valueSource,
    });

    return {
      key: opts.flagKey,
      enabled,
      reason:
        cohort === "variant"
          ? "experiment_variant"
          : cohort === "control"
            ? "experiment_control"
            : "experiment_holdout",
      environment: opts.env,
      valueSource: opts.valueSource,
      evaluatedAt: Timestamp(),
      source: opts.source,
      experiment: { id: opts.experiment.id, cohort },
    };
  }

  const result = evaluateTargeting({
    flagEnabled: opts.enabled,
    rolloutPercentage: opts.rolloutPercentage,
    flagKey: opts.flagKey,
    userId: opts.userId,
  });

  flagEvaluationsByKey.inc({
    flag_key: opts.flagKey,
    result: result.enabled ? "enabled" : "disabled",
    source: opts.valueSource,
  });

  return {
    key: opts.flagKey,
    enabled: result.enabled,
    reason: result.reason,
    environment: opts.env,
    valueSource: opts.valueSource,
    evaluatedAt: Timestamp(),
    source: opts.source,
  };
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

              return buildResponse({
                flagKey,
                env,
                userId,
                enabled: cached.enabled,
                rolloutPercentage: cached.rolloutPercentage,
                valueSource: cached.valueSource,
                experiment: cached.experiment ?? null,
                source: "cache",
              });
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

      // Running experiment (if any) wins over percentage targeting.
      // Lookup is DB-only for now; result is folded into the cache payload
      // so subsequent evaluations hit Redis in a single round-trip.
      const runningExperiment = await fastify.db.query.experiments.findFirst({
        where: and(eq(experiments.flagKey, flagKey), eq(experiments.status, "running")),
      });

      // Resolve: override wins, else flag default
      const resolvedEnabled = override ? override.enabled : flag.enabled;
      const resolvedRollout = override ? override.rolloutPercentage : flag.rolloutPercentage;
      const valueSource: EvaluateValueSource = override ? "override" : "default";

      const cachedExperiment: CachedExperiment | null = runningExperiment
        ? {
            id: runningExperiment.id,
            controlPercentage: runningExperiment.controlPercentage,
            variantPercentage: runningExperiment.variantPercentage,
          }
        : null;

      // Populate cache with resolved config (including experiment shape)
      if (fastify.cache) {
        const cacheValue = JSON.stringify({
          enabled: resolvedEnabled,
          rolloutPercentage: resolvedRollout,
          valueSource,
          experiment: cachedExperiment,
        } satisfies CachedFlagConfig);

        await fastify.cache
          .set(cacheKey, cacheValue, "EX", CACHE_TTL_SECONDS)
          .catch((err: Error) => request.log.warn({ err }, "Cache write failed"));
      }

      flagEvaluations.inc({ source: "database" });

      return buildResponse({
        flagKey,
        env,
        userId,
        enabled: resolvedEnabled,
        rolloutPercentage: resolvedRollout,
        valueSource,
        experiment: cachedExperiment,
        source: "database",
      });
    },
  });
};

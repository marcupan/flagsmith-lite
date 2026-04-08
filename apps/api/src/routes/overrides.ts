import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  isEnvironment,
  Timestamp,
  type Environment,
  type FlagOverride,
  type SetOverrideBody,
} from "@project/shared";
import { appError, flagNotFound } from "../errors.js";
import { flags, flagOverrides } from "../schema.js";
import { ENVIRONMENTS } from "@project/shared";
import { recordAudit, diffChanges, hashActor } from "../audit.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const setOverrideSchema = {
  body: {
    type: "object",
    required: ["enabled"],
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      rolloutPercentage: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
};

function toOverrideResponse(row: typeof flagOverrides.$inferSelect): FlagOverride {
  return {
    environment: row.environment as Environment,
    enabled: row.enabled,
    rolloutPercentage: row.rolloutPercentage,
    createdAt: Timestamp(row.createdAt),
    updatedAt: Timestamp(row.updatedAt),
  };
}

/**
 * Invalidate all environment-scoped cache entries for a flag.
 * Called when a flag default changes (affects all envs without overrides).
 */
export async function invalidateAllEnvCaches(
  cache: Cache | null,
  flagKey: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  if (!cache) {
    return;
  }

  const keys = ENVIRONMENTS.map((env) => `flag:${env}:${flagKey}`);
  // Also invalidate the no-env cache key (backward compat during migration)
  keys.push(`flag:${flagKey}`);

  await cache.del(...keys).catch((err: Error) => log.warn({ err }, "Cache invalidation failed"));
}

/**
 * Invalidate cache for a single (flag, environment) pair.
 * Called when an override is created, updated, or deleted.
 */
async function invalidateEnvCache(
  cache: Cache | null,
  flagKey: string,
  env: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  if (!cache) {
    return;
  }

  await cache
    .del(`flag:${env}:${flagKey}`)
    .catch((err: Error) => log.warn({ err }, "Cache invalidation failed"));
}

export const overridesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /flags/:key/overrides — list all overrides for a flag
  fastify.get<{ Params: { key: string }; Reply: FlagOverride[] }>("/", async (request) => {
    const flag = await fastify.db.query.flags.findFirst({
      where: eq(flags.key, request.params.key),
    });

    if (!flag) {
      throw flagNotFound(request.params.key);
    }

    const rows = await fastify.db.query.flagOverrides.findMany({
      where: eq(flagOverrides.flagId, flag.id),
    });

    return rows.map(toOverrideResponse);
  });

  // PUT /flags/:key/overrides/:env — set (upsert) an override
  fastify.put<{
    Params: { key: string; env: string };
    Body: SetOverrideBody;
    Reply: FlagOverride;
  }>("/:env", { schema: setOverrideSchema }, async (request, reply) => {
    const { key, env } = request.params;

    if (!isEnvironment(env)) {
      throw appError(
        "INVALID_ENVIRONMENT",
        `Invalid environment "${env}". Valid: ${ENVIRONMENTS.join(", ")}`,
      );
    }

    const flag = await fastify.db.query.flags.findFirst({
      where: eq(flags.key, key),
    });

    if (!flag) {
      throw flagNotFound(key);
    }

    // Upsert: insert or update on conflict
    const existing = await fastify.db.query.flagOverrides.findFirst({
      where: and(eq(flagOverrides.flagId, flag.id), eq(flagOverrides.environment, env)),
    });

    let row: typeof flagOverrides.$inferSelect;

    const apiKey = request.headers["x-api-key"] as string;

    if (existing) {
      const before = {
        enabled: existing.enabled,
        rolloutPercentage: existing.rolloutPercentage,
      };

      [row] = await fastify.db
        .update(flagOverrides)
        .set({
          enabled: request.body.enabled,
          rolloutPercentage: request.body.rolloutPercentage ?? existing.rolloutPercentage,
          updatedAt: new Date(),
        })
        .where(eq(flagOverrides.id, existing.id))
        .returning();

      const after = { enabled: row.enabled, rolloutPercentage: row.rolloutPercentage };
      const changes = diffChanges(before, after);

      if (Object.keys(changes).length > 0) {
        void recordAudit(
          fastify.db,
          {
            entityType: "override",
            entityKey: key,
            action: "updated",
            actor: hashActor(apiKey),
            changes,
            metadata: { environment: env },
          },
          request.log,
        );
      }
    } else {
      [row] = await fastify.db
        .insert(flagOverrides)
        .values({
          flagId: flag.id,
          environment: env,
          enabled: request.body.enabled,
          rolloutPercentage: request.body.rolloutPercentage ?? 100,
        })
        .returning();

      void recordAudit(
        fastify.db,
        {
          entityType: "override",
          entityKey: key,
          action: "created",
          actor: hashActor(apiKey),
          changes: diffChanges(
            {},
            {
              enabled: row.enabled,
              rolloutPercentage: row.rolloutPercentage,
            },
          ),
          metadata: { environment: env },
        },
        request.log,
      );

      void reply.status(201);
    }

    await invalidateEnvCache(fastify.cache, key, env, fastify.log);

    return toOverrideResponse(row);
  });

  // DELETE /flags/:key/overrides/:env — remove override (fall back to flag default)
  fastify.delete<{ Params: { key: string; env: string } }>("/:env", async (request, reply) => {
    const { key, env } = request.params;

    if (!isEnvironment(env)) {
      throw appError(
        "INVALID_ENVIRONMENT",
        `Invalid environment "${env}". Valid: ${ENVIRONMENTS.join(", ")}`,
      );
    }

    const flag = await fastify.db.query.flags.findFirst({
      where: eq(flags.key, key),
    });

    if (!flag) {
      throw flagNotFound(key);
    }

    const [deleted] = await fastify.db
      .delete(flagOverrides)
      .where(and(eq(flagOverrides.flagId, flag.id), eq(flagOverrides.environment, env)))
      .returning();

    if (!deleted) {
      throw appError("OVERRIDE_NOT_FOUND", `No override for flag "${key}" in environment "${env}"`);
    }

    const apiKey = request.headers["x-api-key"] as string;

    void recordAudit(
      fastify.db,
      {
        entityType: "override",
        entityKey: key,
        action: "deleted",
        actor: hashActor(apiKey),
        changes: diffChanges(
          {
            enabled: deleted.enabled,
            rolloutPercentage: deleted.rolloutPercentage,
          },
          {},
        ),
        metadata: { environment: env },
      },
      request.log,
    );

    await invalidateEnvCache(fastify.cache, key, env, fastify.log);

    return reply.status(200).send({ deleted: true });
  });
};

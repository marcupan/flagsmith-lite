import { eq, desc } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { CreateFlagBody, Flag, UpdateFlagBody } from "@project/shared";
import { flagKeyExists, flagNotFound } from "../errors.js";
import { toFlagResponse } from "../mappers.js";
import { flags } from "../schema.js";
import { enqueueDeliveries } from "../delivery-service.js";
import { invalidateAllEnvCaches } from "./overrides.js";
import { recordAudit, diffChanges, hashActor } from "../audit.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
  interface FastifyRequest {
    correlationId: string;
  }
}

const createFlagSchema = {
  body: {
    type: "object",
    required: ["key", "name"],
    additionalProperties: false,
    properties: {
      key: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z0-9_-]+$",
      },
      name: { type: "string", minLength: 1, maxLength: 256 },
      enabled: { type: "boolean" },
      description: { type: "string", maxLength: 1024 },
      rolloutPercentage: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
};

const updateFlagSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 256 },
      enabled: { type: "boolean" },
      description: { type: "string", maxLength: 1024 },
      rolloutPercentage: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
};

export const flagsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /flags — list all flags sorted by creation time (newest first)
  fastify.get<{ Reply: Flag[] }>("/", async () => {
    const rows = await fastify.db.query.flags.findMany({
      orderBy: [desc(flags.createdAt)],
    });

    return rows.map(toFlagResponse);
  });

  // POST /flags — create a new flag
  fastify.post<{ Body: CreateFlagBody; Reply: Flag }>(
    "/",
    { schema: createFlagSchema },
    async (request, reply) => {
      const existing = await fastify.db.query.flags.findFirst({
        where: eq(flags.key, request.body.key),
      });

      if (existing) {
        throw flagKeyExists(request.body.key);
      }

      const [row] = await fastify.db
        .insert(flags)
        .values({
          key: request.body.key,
          name: request.body.name,
          enabled: request.body.enabled ?? false,
          description: request.body.description ?? null,
          rolloutPercentage: request.body.rolloutPercentage ?? 100,
        })
        .returning();

      // Fire-and-forget: audit write failure never blocks the response
      const apiKey = request.headers["x-api-key"] as string;
      void recordAudit(
        fastify.db,
        {
          entityType: "flag",
          entityKey: row.key,
          action: "created",
          actor: hashActor(apiKey),
          changes: diffChanges(
            {},
            {
              key: row.key,
              name: row.name,
              enabled: row.enabled,
              description: row.description,
              rolloutPercentage: row.rolloutPercentage,
            },
          ),
        },
        request.log,
      );

      return reply.status(201).send(toFlagResponse(row));
    },
  );

  // GET /flags/:key — get a single flag
  fastify.get<{ Params: { key: string }; Reply: Flag }>("/:key", async (request) => {
    const row = await fastify.db.query.flags.findFirst({
      where: eq(flags.key, request.params.key),
    });

    if (!row) {
      throw flagNotFound(request.params.key);
    }

    return toFlagResponse(row);
  });

  // PUT /flags/:key — update flag fields
  fastify.put<{ Params: { key: string }; Body: UpdateFlagBody; Reply: Flag }>(
    "/:key",
    { schema: updateFlagSchema },
    async (request) => {
      const existing = await fastify.db.query.flags.findFirst({
        where: eq(flags.key, request.params.key),
      });

      if (!existing) {
        throw flagNotFound(request.params.key);
      }

      const updates: Partial<typeof flags.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (request.body.name !== undefined) {
        updates.name = request.body.name;
      }

      if (request.body.enabled !== undefined) {
        updates.enabled = request.body.enabled;
      }

      if (request.body.description !== undefined) {
        updates.description = request.body.description;
      }

      if (request.body.rolloutPercentage !== undefined) {
        updates.rolloutPercentage = request.body.rolloutPercentage;
        // Setting rollout automatically enables the flag — a flag with
        // rolloutPercentage makes no sense in disabled state
        if (updates.enabled === undefined) {
          updates.enabled = true;
        }
      }

      // Snapshot before state for audit diff
      const before = {
        name: existing.name,
        enabled: existing.enabled,
        description: existing.description,
        rolloutPercentage: existing.rolloutPercentage,
      };

      const [row] = await fastify.db
        .update(flags)
        .set(updates)
        .where(eq(flags.key, request.params.key))
        .returning();

      // Compute diff and record audit event (fire-and-forget)
      const after = {
        name: row.name,
        enabled: row.enabled,
        description: row.description,
        rolloutPercentage: row.rolloutPercentage,
      };
      const changes = diffChanges(before, after);

      if (Object.keys(changes).length > 0) {
        const apiKey = request.headers["x-api-key"] as string;

        void recordAudit(
          fastify.db,
          {
            entityType: "flag",
            entityKey: row.key,
            action: "updated",
            actor: hashActor(apiKey),
            changes,
          },
          request.log,
        );
      }

      // Invalidate cache for all environments (flag default change affects all)
      await invalidateAllEnvCaches(fastify.cache, request.params.key, fastify.log);

      // Dispatch webhook deliveries when a flag is toggled
      if (request.body.enabled !== undefined) {
        const enqueued = await enqueueDeliveries(fastify.db, {
          flagKey: row.key,
          eventType: "flag.toggled",
          enabled: row.enabled,
          correlationId: request.correlationId,
        }).catch((err: Error) => {
          request.log.error({ err }, "Failed to enqueue webhook deliveries");
          return 0;
        });

        if (enqueued > 0) {
          request.log.info({ flagKey: row.key, enqueued }, "Webhook deliveries enqueued");
        }
      }

      return toFlagResponse(row);
    },
  );

  // DELETE /flags/:key — remove flag
  fastify.delete<{ Params: { key: string }; Reply: { deleted: true } }>(
    "/:key",
    async (request, reply) => {
      const [deleted] = await fastify.db
        .delete(flags)
        .where(eq(flags.key, request.params.key))
        .returning();

      if (!deleted) {
        throw flagNotFound(request.params.key);
      }

      // Record audit for deletion — diff is full object → empty
      const apiKey = request.headers["x-api-key"] as string;

      void recordAudit(
        fastify.db,
        {
          entityType: "flag",
          entityKey: deleted.key,
          action: "deleted",
          actor: hashActor(apiKey),
          changes: diffChanges(
            {
              key: deleted.key,
              name: deleted.name,
              enabled: deleted.enabled,
              description: deleted.description,
              rolloutPercentage: deleted.rolloutPercentage,
            },
            {},
          ),
        },
        request.log,
      );

      // Invalidate cache for all environments after deletion
      await invalidateAllEnvCaches(fastify.cache, request.params.key, fastify.log);

      return reply.status(200).send({ deleted: true });
    },
  );
};

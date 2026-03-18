import { eq, desc } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { CreateFlagBody, Flag, UpdateFlagBody } from "@project/shared";
import { flagKeyExists, flagNotFound } from "../errors.js";
import { flags } from "../schema.js";
import type { Db } from "../db.js";
import type { Cache } from "../cache.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

// Convert DB row dates to ISO strings for the API response
function toFlagResponse(row: typeof flags.$inferSelect): Flag {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
        })
        .returning();

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

      const [row] = await fastify.db
        .update(flags)
        .set(updates)
        .where(eq(flags.key, request.params.key))
        .returning();

      // Invalidate cache for this flag key after any update
      if (fastify.cache) {
        await fastify.cache
          .del(`flag:${request.params.key}`)
          .catch((err: Error) => fastify.log.warn({ err }, "Cache invalidation failed"));
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

      // Invalidate cache after deletion
      if (fastify.cache) {
        await fastify.cache
          .del(`flag:${request.params.key}`)
          .catch((err: Error) => fastify.log.warn({ err }, "Cache invalidation failed"));
      }

      return reply.status(200).send({ deleted: true });
    },
  );
};

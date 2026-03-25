import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type { DeliveryState, WebhookDelivery, DeliveryTransition } from "@project/shared";

import { toDeliveryResponse, toTransitionResponse } from "../mappers.js";
import { webhookDeliveries, deliveryTransitions } from "../schema.js";
import type { Db } from "../db.js";

/** States that can be replayed — only terminal or permanently failed. */
const REPLAYABLE_STATES: DeliveryState[] = ["failed", "dead"];

interface DeliveryStats {
  pending: number;
  sending: number;
  delivered: number;
  failed: number;
  retrying: number;
  dead: number;
}

function parseId(raw: string): number | null {
  const id = Number(raw);

  return Number.isInteger(id) && id > 0 ? id : null;
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ code: "DELIVERY_NOT_FOUND", message: "Not found" } as never);
}

async function findDelivery(db: Db, id: number) {
  return db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.id, id),
  });
}

// Drizzle sql`` tagged templates use `count(*)::int` which IDE SQL inspectors
// misparse — the runtime and TypeScript compiler handle them correctly.

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /admin/delivery-stats — aggregate counts by state
  fastify.get<{ Reply: DeliveryStats }>("/delivery-stats", async () => {
    const countExpr = sql<number>`count(*)::int`;

    const rows = await fastify.db
      .select({ state: webhookDeliveries.state, count: countExpr })
      .from(webhookDeliveries)
      .groupBy(webhookDeliveries.state);

    const stats: DeliveryStats = {
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      retrying: 0,
      dead: 0,
    };

    for (const row of rows) {
      if (row.state in stats) {
        stats[row.state as DeliveryState] = row.count;
      }
    }

    return stats;
  });

  // GET /admin/deliveries/:id — single delivery detail
  fastify.get<{ Params: { id: string }; Reply: WebhookDelivery }>(
    "/deliveries/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id) return notFound(reply);

      const row = await findDelivery(fastify.db, id);
      if (!row) return notFound(reply);

      return toDeliveryResponse(row);
    },
  );

  // GET /admin/deliveries/:id/transitions — audit log for a delivery
  fastify.get<{ Params: { id: string }; Reply: DeliveryTransition[] }>(
    "/deliveries/:id/transitions",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id) return notFound(reply);

      const delivery = await findDelivery(fastify.db, id);
      if (!delivery) return notFound(reply);

      const rows = await fastify.db.query.deliveryTransitions.findMany({
        where: eq(deliveryTransitions.deliveryId, id),
        orderBy: [deliveryTransitions.createdAt],
      });

      return rows.map(toTransitionResponse);
    },
  );

  // POST /admin/deliveries/:id/replay — re-enqueue a failed/dead delivery
  fastify.post<{ Params: { id: string }; Reply: WebhookDelivery }>(
    "/deliveries/:id/replay",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id) return notFound(reply);

      const delivery = await findDelivery(fastify.db, id);
      if (!delivery) return notFound(reply);

      if (!REPLAYABLE_STATES.includes(delivery.state as DeliveryState)) {
        return reply.status(409).send({
          code: "REPLAY_NOT_ALLOWED",
          message: `Cannot replay delivery in state "${delivery.state}". Only failed and dead deliveries can be replayed.`,
        } as never);
      }

      const oldCorrelationId = delivery.correlationId;
      const newCorrelationId = randomUUID();

      // Reset delivery state to pending
      const [updated] = await fastify.db
        .update(webhookDeliveries)
        .set({
          state: "pending",
          attempts: 0,
          lastError: null,
          correlationId: newCorrelationId,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, id))
        .returning();

      // Log the replay transition with linkage to the old correlation
      await fastify.db.insert(deliveryTransitions).values({
        deliveryId: id,
        fromState: delivery.state,
        toState: "pending",
        reason: `Manual replay (old correlationId: ${oldCorrelationId})`,
      });

      request.log.info({ deliveryId: id, oldCorrelationId, newCorrelationId }, "Delivery replayed");

      return reply.status(200).send(toDeliveryResponse(updated));
    },
  );
};

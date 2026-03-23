import { eq, desc } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  WEBHOOK_EVENT_TYPES,
  type CreateWebhookBody,
  type WebhookEventType,
  type WebhookSubscription,
} from "@project/shared";
import { webhookNotFound, webhookInvalidUrl, webhookInvalidEvents } from "../errors.js";
import { toWebhookResponse } from "../mappers.js";
import { webhookSubscriptions } from "../schema.js";

const URL_RE = /^https?:\/\/.+/;

function isValidWebhookUrl(url: string): boolean {
  return URL_RE.test(url);
}

function areValidEvents(events: unknown[]): events is WebhookEventType[] {
  return (
    events.length > 0 &&
    events.every(
      (e) => typeof e === "string" && WEBHOOK_EVENT_TYPES.includes(e as WebhookEventType),
    )
  );
}

const createWebhookSchema = {
  body: {
    type: "object",
    required: ["url", "events", "secret"],
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
      events: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
      secret: { type: "string", minLength: 16, maxLength: 256 },
    },
  },
};

export const webhooksRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /webhooks — register a new webhook subscription
  fastify.post<{ Body: CreateWebhookBody; Reply: WebhookSubscription }>(
    "/",
    { schema: createWebhookSchema },
    async (request, reply) => {
      const { url, events, secret } = request.body;

      if (!isValidWebhookUrl(url)) {
        throw webhookInvalidUrl(url);
      }

      if (!areValidEvents(events)) {
        throw webhookInvalidEvents();
      }

      const [row] = await fastify.db
        .insert(webhookSubscriptions)
        .values({
          url,
          events,
          secret,
        })
        .returning();

      request.log.info({ subscriptionId: row.id, url, events }, "Webhook subscription created");

      return reply.status(201).send(toWebhookResponse(row));
    },
  );

  // GET /webhooks — list all subscriptions
  fastify.get<{ Reply: WebhookSubscription[] }>("/", async () => {
    const rows = await fastify.db.query.webhookSubscriptions.findMany({
      orderBy: [desc(webhookSubscriptions.createdAt)],
    });

    return rows.map(toWebhookResponse);
  });

  // DELETE /webhooks/:id — remove a subscription (cascades deliveries)
  fastify.delete<{ Params: { id: string }; Reply: { deleted: true } }>(
    "/:id",
    async (request, reply) => {
      const id = Number(request.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        throw webhookNotFound(id);
      }

      const [deleted] = await fastify.db
        .delete(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, id))
        .returning();

      if (!deleted) {
        throw webhookNotFound(id);
      }

      request.log.info({ subscriptionId: id }, "Webhook subscription deleted");

      return reply.status(200).send({ deleted: true });
    },
  );
};

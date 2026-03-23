/**
 * Pure data-mapping functions — no I/O, no side effects.
 * Extracted for unit testability and reuse across routes.
 */
import {
  FlagKey,
  Timestamp,
  type Flag,
  type WebhookSubscription,
  type WebhookEventType,
} from "@project/shared";
import type { flags, webhookSubscriptions } from "./schema.js";

/** DB row → API response. Brands key and converts Date → Timestamp. */
export function toFlagResponse(row: typeof flags.$inferSelect): Flag {
  return {
    id: row.id,
    key: FlagKey(row.key),
    name: row.name,
    enabled: row.enabled,
    description: row.description,
    createdAt: Timestamp(row.createdAt),
    updatedAt: Timestamp(row.updatedAt),
  };
}

/** DB row → API response for webhook subscription. Secret is never exposed. */
export function toWebhookResponse(
  row: typeof webhookSubscriptions.$inferSelect,
): WebhookSubscription {
  return {
    id: row.id,
    url: row.url,
    events: row.events as WebhookEventType[],
    active: row.active,
    createdAt: Timestamp(row.createdAt),
    updatedAt: Timestamp(row.updatedAt),
  };
}

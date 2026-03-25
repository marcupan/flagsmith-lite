/**
 * Pure data-mapping functions — no I/O, no side effects.
 * Extracted for unit testability and reuse across routes.
 */
import {
  FlagKey,
  Timestamp,
  type Flag,
  type WebhookSubscription,
  type WebhookDelivery,
  type DeliveryTransition,
  type WebhookEventType,
  type DeliveryState,
} from "@project/shared";
import type {
  flags,
  webhookSubscriptions,
  webhookDeliveries,
  deliveryTransitions,
} from "./schema.js";

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

/** DB row → API response for webhook delivery. */
export function toDeliveryResponse(row: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    flagKey: FlagKey(row.flagKey),
    eventType: row.eventType as WebhookEventType,
    state: row.state as DeliveryState,
    attempts: row.attempts,
    lastError: row.lastError,
    correlationId: row.correlationId,
    createdAt: Timestamp(row.createdAt),
    updatedAt: Timestamp(row.updatedAt),
  };
}

/** DB row → API response for delivery transition audit log entry. */
export function toTransitionResponse(
  row: typeof deliveryTransitions.$inferSelect,
): DeliveryTransition {
  return {
    deliveryId: row.deliveryId,
    from: row.fromState as DeliveryState | null,
    to: row.toState as DeliveryState,
    reason: row.reason,
    timestamp: Timestamp(row.createdAt),
  };
}

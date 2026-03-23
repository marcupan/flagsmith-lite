/**
 * Webhook delivery orchestration — enqueue and process deliveries.
 *
 * Enqueue: creates delivery rows + transition audit log entries.
 * Process: sends HTTP POST to consumer, manages state transitions.
 *
 * This module has no Fastify dependency — it takes a Db instance
 * directly, making it testable without spinning up a server.
 */

import { createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { type WebhookEventType, transition, type WebhookPayload } from "@project/shared";
import { webhookSubscriptions, webhookDeliveries, deliveryTransitions } from "./schema.js";
import type { Db } from "./db.js";

// ── Configuration ────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const DELIVERY_TIMEOUT_MS = 10_000;

// ── Enqueue ──────────────────────────────────────────────────────────────

export interface EnqueueParams {
  flagKey: string;
  eventType: WebhookEventType;
  enabled: boolean;
}

/**
 * Find all active subscriptions listening for the given event type,
 * create a pending delivery row for each, and log the initial transition.
 * Returns the number of deliveries enqueued.
 */
export async function enqueueDeliveries(db: Db, params: EnqueueParams): Promise<number> {
  const subs = await db.query.webhookSubscriptions.findMany({
    where: eq(webhookSubscriptions.active, true),
  });

  const relevant = subs.filter((s) => s.events.includes(params.eventType));

  if (relevant.length === 0) {
    return 0;
  }

  let enqueued = 0;

  for (const sub of relevant) {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: params.flagKey,
        eventType: params.eventType,
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: `Flag "${params.flagKey}" ${params.eventType}`,
    });

    enqueued++;
  }

  return enqueued;
}

// ── Process (Worker) ─────────────────────────────────────────────────────

/**
 * Sign a payload body with HMAC-SHA256 using the subscription secret.
 */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Record a state transition in both the delivery row and the audit log.
 */
async function transitionDelivery(
  db: Db,
  deliveryId: number,
  fromState: string,
  toState: string,
  reason: string,
  extraUpdates?: Partial<typeof webhookDeliveries.$inferInsert>,
): Promise<void> {
  // Validate via state machine (throws on invalid transition)
  transition(
    fromState as Parameters<typeof transition>[0],
    toState as Parameters<typeof transition>[1],
  );

  await db
    .update(webhookDeliveries)
    .set({
      state: toState,
      updatedAt: new Date(),
      ...extraUpdates,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  await db.insert(deliveryTransitions).values({
    deliveryId,
    fromState,
    toState,
    reason,
  });
}

/**
 * Process a single pending delivery:
 * 1. Transition pending → sending
 * 2. Build and sign the payload
 * 3. POST to the consumer URL
 * 4. On 2xx → delivered
 * 5. On 4xx → failed (permanent, no retry)
 * 6. On 5xx/timeout → retrying (or dead if max attempts reached)
 */
export async function processDelivery(db: Db, deliveryId: number): Promise<void> {
  // Fetch the delivery + its subscription
  const delivery = await db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.id, deliveryId),
  });

  if (!delivery) return;

  const subscription = await db.query.webhookSubscriptions.findFirst({
    where: eq(webhookSubscriptions.id, delivery.subscriptionId),
  });

  if (!subscription) {
    // Subscription was deleted — mark delivery as failed
    await transitionDelivery(db, deliveryId, delivery.state, "failed", "Subscription deleted");
    await transitionDelivery(db, deliveryId, "failed", "dead", "Subscription no longer exists");

    return;
  }

  // 1. pending → sending (or retrying → sending)
  await transitionDelivery(db, deliveryId, delivery.state, "sending", "Worker picked up delivery");

  // 2. Build payload
  const payload: WebhookPayload = {
    event: delivery.eventType as WebhookEventType,
    key: delivery.flagKey,
    enabled: true, // Will be resolved from flag state in future phases
    timestamp: new Date().toISOString(),
    deliveryId: delivery.id,
  };

  const body = JSON.stringify(payload);
  const signature = signPayload(body, subscription.secret);
  const attemptNumber = delivery.attempts + 1;

  // 3. POST to consumer
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Delivery-Id": String(delivery.id),
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      // 4. 2xx → delivered
      await transitionDelivery(db, deliveryId, "sending", "delivered", `HTTP ${response.status}`, {
        attempts: attemptNumber,
      });
    } else if (response.status >= 400 && response.status < 500) {
      // 5. 4xx → failed (permanent)
      await transitionDelivery(
        db,
        deliveryId,
        "sending",
        "failed",
        `HTTP ${response.status} (permanent)`,
        { attempts: attemptNumber, lastError: `HTTP ${response.status}` },
      );
      // Permanent failure → dead immediately
      await transitionDelivery(db, deliveryId, "failed", "dead", "4xx is not retryable");
    } else {
      // 6. 5xx → retrying or dead
      await handleRetry(db, deliveryId, attemptNumber, `HTTP ${response.status}`);
    }
  } catch (err) {
    // Network error or timeout
    const message = err instanceof Error ? err.message : "Unknown error";
    await handleRetry(db, deliveryId, attemptNumber, message);
  }
}

/**
 * Handle retry logic: if under max attempts → retrying, else → failed → dead.
 */
async function handleRetry(
  db: Db,
  deliveryId: number,
  attemptNumber: number,
  errorMessage: string,
): Promise<void> {
  if (attemptNumber < MAX_ATTEMPTS) {
    await transitionDelivery(
      db,
      deliveryId,
      "sending",
      "retrying",
      `Attempt ${attemptNumber}/${MAX_ATTEMPTS}: ${errorMessage}`,
      { attempts: attemptNumber, lastError: errorMessage },
    );
  } else {
    // Max retries exhausted
    await transitionDelivery(
      db,
      deliveryId,
      "sending",
      "failed",
      `Attempt ${attemptNumber}/${MAX_ATTEMPTS}: ${errorMessage}`,
      { attempts: attemptNumber, lastError: errorMessage },
    );
    await transitionDelivery(
      db,
      deliveryId,
      "failed",
      "dead",
      `Max retries (${MAX_ATTEMPTS}) exhausted`,
    );
  }
}

// ── Poll-based worker ────────────────────────────────────────────────────

/**
 * Process all pending and retrying deliveries.
 * In a real system, pg-boss would handle this. For now, we use a simple
 * poll-based approach that can be called on a timer or after flag changes.
 *
 * Returns the number of deliveries processed.
 */
export async function processPendingDeliveries(db: Db): Promise<number> {
  const pending = await db.query.webhookDeliveries.findMany({
    where: and(eq(webhookDeliveries.state, "pending")),
  });

  const retrying = await db.query.webhookDeliveries.findMany({
    where: and(eq(webhookDeliveries.state, "retrying")),
  });

  const all = [...pending, ...retrying];
  let processed = 0;

  for (const delivery of all) {
    await processDelivery(db, delivery.id);
    processed++;
  }

  return processed;
}

/** Exponential backoff delay for retry N. */
export function backoffDelay(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
}

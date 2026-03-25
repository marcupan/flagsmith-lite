import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { webhookSubscriptions, webhookDeliveries, deliveryTransitions, flags } from "../schema.js";
import { enqueueDeliveries, processDelivery, signPayload } from "../delivery-service.js";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(deliveryTransitions);
  await db.delete(webhookDeliveries);
  await db.delete(webhookSubscriptions);
  await db.delete(flags);
});

// ── signPayload ──────────────────────────────────────────────────────────

describe("signPayload", () => {
  it("produces deterministic HMAC-SHA256 signature", () => {
    const body = '{"event":"flag.toggled"}';
    const secret = "test-secret-1234567890";
    const sig1 = signPayload(body, secret);
    const sig2 = signPayload(body, secret);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different secrets produce different signatures", () => {
    const body = '{"event":"flag.toggled"}';
    const sig1 = signPayload(body, "secret-one-1234567");
    const sig2 = signPayload(body, "secret-two-1234567");
    expect(sig1).not.toBe(sig2);
  });
});

// ── enqueueDeliveries ────────────────────────────────────────────────────

describe("enqueueDeliveries", () => {
  it("creates delivery rows for matching subscriptions", async () => {
    // Create a subscription listening for flag.toggled
    await db.insert(webhookSubscriptions).values({
      url: "https://example.com/hook",
      secret: "test-secret-long-enough",
      events: ["flag.toggled"],
      active: true,
    });

    const count = await enqueueDeliveries(db, {
      flagKey: "dark-mode",
      eventType: "flag.toggled",
      enabled: true,
      correlationId: "test-correlation-id",
    });

    expect(count).toBe(1);

    const deliveries = await db.query.webhookDeliveries.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].flagKey).toBe("dark-mode");
    expect(deliveries[0].eventType).toBe("flag.toggled");
    expect(deliveries[0].state).toBe("pending");
  });

  it("skips subscriptions not listening for the event", async () => {
    await db.insert(webhookSubscriptions).values({
      url: "https://example.com/hook",
      secret: "test-secret-long-enough",
      events: ["flag.created"],
      active: true,
    });

    const count = await enqueueDeliveries(db, {
      flagKey: "dark-mode",
      eventType: "flag.toggled",
      enabled: true,
      correlationId: "test-correlation-id",
    });

    expect(count).toBe(0);
  });

  it("skips inactive subscriptions", async () => {
    await db.insert(webhookSubscriptions).values({
      url: "https://example.com/hook",
      secret: "test-secret-long-enough",
      events: ["flag.toggled"],
      active: false,
    });

    const count = await enqueueDeliveries(db, {
      flagKey: "dark-mode",
      eventType: "flag.toggled",
      enabled: true,
      correlationId: "test-correlation-id",
    });

    expect(count).toBe(0);
  });

  it("enqueues to multiple matching subscriptions", async () => {
    await db.insert(webhookSubscriptions).values([
      {
        url: "https://one.example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      },
      {
        url: "https://two.example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled", "flag.created"],
        active: true,
      },
    ]);

    const count = await enqueueDeliveries(db, {
      flagKey: "dark-mode",
      eventType: "flag.toggled",
      enabled: true,
      correlationId: "test-correlation-id",
    });

    expect(count).toBe(2);
  });

  it("records initial transition (null → pending) in audit log", async () => {
    await db.insert(webhookSubscriptions).values({
      url: "https://example.com/hook",
      secret: "test-secret-long-enough",
      events: ["flag.toggled"],
      active: true,
    });

    await enqueueDeliveries(db, {
      flagKey: "dark-mode",
      eventType: "flag.toggled",
      enabled: true,
      correlationId: "test-correlation-id",
    });

    const transitions = await db.query.deliveryTransitions.findMany();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromState).toBeNull();
    expect(transitions[0].toState).toBe("pending");
  });
});

// ── processDelivery ──────────────────────────────────────────────────────

describe("processDelivery", () => {
  it("transitions to delivered on 200 response", async () => {
    // Mock fetch to return 200
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: "dark-mode",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "test-correlation-id",
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: "test",
    });

    await processDelivery(db, delivery.id);

    const updated = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, delivery.id),
    });

    expect(updated!.state).toBe("delivered");
    expect(updated!.attempts).toBe(1);

    // Verify fetch was called with correct headers
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect((opts as RequestInit).headers).toHaveProperty("X-Webhook-Signature");
    expect((opts as RequestInit).headers).toHaveProperty("X-Delivery-Id");

    fetchSpy.mockRestore();
  });

  it("transitions to dead on 4xx response (permanent failure)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: "dark-mode",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "test-correlation-id",
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: "test",
    });

    await processDelivery(db, delivery.id);

    const updated = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, delivery.id),
    });

    // 4xx → failed → dead (permanent, no retry)
    expect(updated!.state).toBe("dead");
    expect(updated!.lastError).toBe("HTTP 404");

    vi.restoreAllMocks();
  });

  it("transitions to retrying on 500 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: "dark-mode",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "test-correlation-id",
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: "test",
    });

    await processDelivery(db, delivery.id);

    const updated = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, delivery.id),
    });

    expect(updated!.state).toBe("retrying");
    expect(updated!.attempts).toBe(1);
    expect(updated!.lastError).toBe("HTTP 500");

    vi.restoreAllMocks();
  });

  it("transitions to dead after max retries exhausted on 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    // Simulate delivery already at attempt 4 (next will be 5 = MAX)
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: "dark-mode",
        eventType: "flag.toggled",
        state: "retrying",
        attempts: 4,
        correlationId: "test-correlation-id",
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: "test",
    });

    await processDelivery(db, delivery.id);

    const updated = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, delivery.id),
    });

    expect(updated!.state).toBe("dead");
    expect(updated!.attempts).toBe(5);

    vi.restoreAllMocks();
  });

  it("handles network errors (fetch throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: sub.id,
        flagKey: "dark-mode",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "test-correlation-id",
      })
      .returning();

    await db.insert(deliveryTransitions).values({
      deliveryId: delivery.id,
      fromState: null,
      toState: "pending",
      reason: "test",
    });

    await processDelivery(db, delivery.id);

    const updated = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, delivery.id),
    });

    expect(updated!.state).toBe("retrying");
    expect(updated!.lastError).toBe("ECONNREFUSED");

    vi.restoreAllMocks();
  });
});

// ── Flag toggle dispatches deliveries ────────────────────────────────────

describe("PUT /api/v1/flags/:key dispatches webhook deliveries", () => {
  it("enqueues deliveries when flag is toggled", async () => {
    // Create a flag
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "dark-mode", name: "Dark Mode" },
    });

    // Create a subscription
    await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: {
        url: "https://consumer.example.com/hook",
        events: ["flag.toggled"],
        secret: "a-long-secret-for-test",
      },
    });

    // Toggle the flag
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode",
      headers: authHeader,
      payload: { enabled: true },
    });

    // Check deliveries were enqueued
    const deliveries = await db.query.webhookDeliveries.findMany();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].flagKey).toBe("dark-mode");
    expect(deliveries[0].eventType).toBe("flag.toggled");
    expect(deliveries[0].state).toBe("pending");
  });

  it("does NOT enqueue when only name is updated (no toggle)", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "beta", name: "Beta" },
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: {
        url: "https://consumer.example.com/hook",
        events: ["flag.toggled"],
        secret: "a-long-secret-for-test",
      },
    });

    // Update only name, not enabled
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/beta",
      headers: authHeader,
      payload: { name: "Beta Feature" },
    });

    const deliveries = await db.query.webhookDeliveries.findMany();
    expect(deliveries).toHaveLength(0);
  });
});

// ── GET deliveries endpoint ──────────────────────────────────────────────

describe("GET /api/v1/webhooks/:id/deliveries", () => {
  it("returns deliveries for a subscription", async () => {
    const createRes = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: {
        url: "https://consumer.example.com/hook",
        events: ["flag.toggled"],
        secret: "a-long-secret-for-test",
      },
    });
    const { id } = createRes.json();

    // Create a flag and toggle it
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "test-flag", name: "Test" },
    });

    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/test-flag",
      headers: authHeader,
      payload: { enabled: true },
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/webhooks/${id}/deliveries`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].subscriptionId).toBe(id);
    expect(body[0].state).toBe("pending");
  });

  it("returns 404 for nonexistent subscription", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/webhooks/99999/deliveries",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

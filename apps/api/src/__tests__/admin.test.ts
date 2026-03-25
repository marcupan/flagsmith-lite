import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { webhookSubscriptions, webhookDeliveries, deliveryTransitions, flags } from "../schema.js";
import { enqueueDeliveries } from "../delivery-service.js";

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

// ── GET /admin/delivery-stats ───────────────────────────────────────────

describe("GET /api/v1/admin/delivery-stats", () => {
  it("returns zeroes when no deliveries exist", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/delivery-stats",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      retrying: 0,
      dead: 0,
    });
  });

  it("returns correct counts per state", async () => {
    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    // Create deliveries in different states
    await db.insert(webhookDeliveries).values([
      {
        subscriptionId: sub.id,
        flagKey: "a",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "cid-1",
      },
      {
        subscriptionId: sub.id,
        flagKey: "b",
        eventType: "flag.toggled",
        state: "delivered",
        correlationId: "cid-2",
      },
      {
        subscriptionId: sub.id,
        flagKey: "c",
        eventType: "flag.toggled",
        state: "delivered",
        correlationId: "cid-3",
      },
      {
        subscriptionId: sub.id,
        flagKey: "d",
        eventType: "flag.toggled",
        state: "dead",
        correlationId: "cid-4",
      },
    ]);

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/delivery-stats",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending).toBe(1);
    expect(body.delivered).toBe(2);
    expect(body.dead).toBe(1);
  });

  it("rejects without auth", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/delivery-stats",
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── GET /admin/deliveries/:id ───────────────────────────────────────────

describe("GET /api/v1/admin/deliveries/:id", () => {
  it("returns delivery detail with correlationId", async () => {
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
        correlationId: "trace-abc-123",
      })
      .returning();

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/admin/deliveries/${delivery.id}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(delivery.id);
    expect(body.correlationId).toBe("trace-abc-123");
    expect(body.flagKey).toBe("dark-mode");
    expect(body.state).toBe("pending");
  });

  it("returns 404 for nonexistent delivery", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/deliveries/99999",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── GET /admin/deliveries/:id/transitions ───────────────────────────────

describe("GET /api/v1/admin/deliveries/:id/transitions", () => {
  it("returns transition audit log in chronological order", async () => {
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
      correlationId: "trace-xyz",
    });

    expect(count).toBe(1);

    const deliveries = await db.query.webhookDeliveries.findMany();
    const deliveryId = deliveries[0].id;

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/admin/deliveries/${deliveryId}/transitions`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].from).toBeNull();
    expect(body[0].to).toBe("pending");
  });

  it("returns 404 for nonexistent delivery", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/deliveries/99999/transitions",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── POST /admin/deliveries/:id/replay ──────────────────────────────────

describe("POST /api/v1/admin/deliveries/:id/replay", () => {
  it("replays a dead delivery — resets to pending with new correlationId", async () => {
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
        state: "dead",
        attempts: 5,
        lastError: "HTTP 500",
        correlationId: "old-correlation-id",
      })
      .returning();

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/admin/deliveries/${delivery.id}/replay`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("pending");
    expect(body.attempts).toBe(0);
    expect(body.lastError).toBeNull();
    expect(body.correlationId).not.toBe("old-correlation-id");

    // Check audit log has replay transition
    const transitions = await db.query.deliveryTransitions.findMany();
    const replayTransition = transitions.find(
      (t) => t.fromState === "dead" && t.toState === "pending",
    );
    expect(replayTransition).toBeDefined();
    expect(replayTransition!.reason).toContain("Manual replay");
    expect(replayTransition!.reason).toContain("old-correlation-id");
  });

  it("replays a failed delivery", async () => {
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
        state: "failed",
        correlationId: "cid-fail",
      })
      .returning();

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/admin/deliveries/${delivery.id}/replay`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("pending");
  });

  it("rejects replay of pending delivery (409)", async () => {
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
        correlationId: "cid-pending",
      })
      .returning();

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/admin/deliveries/${delivery.id}/replay`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects replay of delivered delivery (409)", async () => {
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
        state: "delivered",
        correlationId: "cid-delivered",
      })
      .returning();

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/admin/deliveries/${delivery.id}/replay`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for nonexistent delivery", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/admin/deliveries/99999/replay",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── Correlation ID propagation ──────────────────────────────────────────

describe("correlationId flow", () => {
  it("correlationId passes from flag toggle to delivery", async () => {
    // Create flag
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "corr-test", name: "Correlation Test" },
    });

    // Create subscription
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

    // Toggle with explicit correlation ID
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/corr-test",
      headers: {
        ...authHeader,
        "x-correlation-id": "my-trace-001",
      },
      payload: { enabled: true },
    });

    // Check that the delivery has the same correlationId
    const deliveries = await db.query.webhookDeliveries.findMany();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].correlationId).toBe("my-trace-001");
  });

  it("auto-generates correlationId when none provided", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "auto-corr", name: "Auto Correlation" },
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

    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/auto-corr",
      headers: authHeader,
      payload: { enabled: true },
    });

    const deliveries = await db.query.webhookDeliveries.findMany();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    // Should be a UUID-like string (auto-generated)
    expect(deliveries[0].correlationId).toMatch(/^[\w-]+$/);
    expect(deliveries[0].correlationId.length).toBeGreaterThan(0);
  });

  it("returns correlationId in admin delivery detail", async () => {
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
        correlationId: "api-response-check",
      })
      .returning();

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/admin/deliveries/${delivery.id}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().correlationId).toBe("api-response-check");
  });
});

// ── GET /webhooks/:id/deliveries with filters ───────────────────────────

describe("GET /api/v1/webhooks/:id/deliveries with filters", () => {
  it("filters by state query param", async () => {
    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    await db.insert(webhookDeliveries).values([
      {
        subscriptionId: sub.id,
        flagKey: "a",
        eventType: "flag.toggled",
        state: "pending",
        correlationId: "c1",
      },
      {
        subscriptionId: sub.id,
        flagKey: "b",
        eventType: "flag.toggled",
        state: "delivered",
        correlationId: "c2",
      },
      {
        subscriptionId: sub.id,
        flagKey: "c",
        eventType: "flag.toggled",
        state: "delivered",
        correlationId: "c3",
      },
    ]);

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/webhooks/${sub.id}/deliveries?state=delivered`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body.every((d: { state: string }) => d.state === "delivered")).toBe(true);
  });

  it("respects limit query param", async () => {
    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({
        url: "https://example.com/hook",
        secret: "test-secret-long-enough",
        events: ["flag.toggled"],
        active: true,
      })
      .returning();

    // Insert 5 deliveries
    for (let i = 0; i < 5; i++) {
      await db.insert(webhookDeliveries).values({
        subscriptionId: sub.id,
        flagKey: `flag-${i}`,
        eventType: "flag.toggled",
        state: "pending",
        correlationId: `c-${i}`,
      });
    }

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/webhooks/${sub.id}/deliveries?limit=2`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

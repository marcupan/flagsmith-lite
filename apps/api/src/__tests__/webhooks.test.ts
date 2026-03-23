import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { webhookSubscriptions, webhookDeliveries } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

const validPayload = {
  url: "https://example.com/webhook",
  events: ["flag.toggled"],
  secret: "a-secret-that-is-long-enough",
};

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(webhookDeliveries);
  await db.delete(webhookSubscriptions);
});

// ── POST /api/v1/webhooks ────────────────────────────────────────────────

describe("POST /api/v1/webhooks", () => {
  it("creates a subscription and returns 201", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: validPayload,
    });

    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.id).toBeTypeOf("number");
    expect(body.url).toBe("https://example.com/webhook");
    expect(body.events).toEqual(["flag.toggled"]);
    expect(body.active).toBe(true);
    // Secret must NOT be returned
    expect(body.secret).toBeUndefined();
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it("returns 401 without API key", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: validPayload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for invalid URL", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, url: "not-a-url" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("WEBHOOK_INVALID_URL");
  });

  it("returns 400 for invalid event types", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, events: ["invalid.event"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("WEBHOOK_INVALID_EVENTS");
  });

  it("returns 400 for empty events array", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, events: [] },
    });

    // JSON schema minItems: 1 catches this
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for secret shorter than 16 chars", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, secret: "short" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts multiple valid event types", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: {
        ...validPayload,
        events: ["flag.toggled", "flag.created", "flag.deleted"],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().events).toEqual(["flag.toggled", "flag.created", "flag.deleted"]);
  });

  it("accepts http URLs (allowed in dev mode)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, url: "http://localhost:9999/hook" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe("http://localhost:9999/hook");
  });
});

// ── GET /api/v1/webhooks ─────────────────────────────────────────────────

describe("GET /api/v1/webhooks", () => {
  it("returns empty array when no subscriptions exist", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns all subscriptions sorted by creation time (newest first)", async () => {
    // Create two subscriptions
    await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, url: "https://first.example.com/hook" },
    });
    await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: { ...validPayload, url: "https://second.example.com/hook" },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: authHeader,
    });

    const body = res.json();
    expect(body).toHaveLength(2);
    // Newest first
    expect(body[0].url).toBe("https://second.example.com/hook");
    expect(body[1].url).toBe("https://first.example.com/hook");
    // No secrets exposed
    expect(body[0].secret).toBeUndefined();
  });

  it("returns 401 without API key", async () => {
    const res = await server.inject({ method: "GET", url: "/api/v1/webhooks" });

    expect(res.statusCode).toBe(401);
  });
});

// ── DELETE /api/v1/webhooks/:id ──────────────────────────────────────────

describe("DELETE /api/v1/webhooks/:id", () => {
  it("deletes an existing subscription", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: authHeader,
      payload: validPayload,
    });
    const { id } = create.json();

    const res = await server.inject({
      method: "DELETE",
      url: `/api/v1/webhooks/${id}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    // Verify it's gone
    const list = await server.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: authHeader,
    });
    expect(list.json()).toHaveLength(0);
  });

  it("returns 404 for nonexistent subscription", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/webhooks/99999",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("WEBHOOK_NOT_FOUND");
  });

  it("returns 404 for invalid id format", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/webhooks/abc",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 without API key", async () => {
    const res = await server.inject({ method: "DELETE", url: "/api/v1/webhooks/1" });

    expect(res.statusCode).toBe(401);
  });
});

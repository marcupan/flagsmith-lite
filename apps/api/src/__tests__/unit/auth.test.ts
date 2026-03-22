import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { authPlugin } from "../../plugins/auth.js";

/**
 * Auth plugin unit tests — no DB, no external services.
 * Uses a minimal Fastify instance with only the auth plugin + a test route.
 */

const TEST_API_KEY = "test-secret-key-12345";

let server: ReturnType<typeof Fastify>;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(authPlugin, { apiKey: TEST_API_KEY });

  // Minimal route to test auth gating
  server.get("/protected", async () => ({ ok: true }));

  await server.ready();
});

afterAll(() => server.close());

describe("auth plugin", () => {
  it("allows request with correct API key", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects request with wrong API key (401)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "wrong-key" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("rejects request with missing API key header (401)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      // no x-api-key header
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("rejects request with empty API key (401)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("includes requestId in error response", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "bad" },
    });

    expect(res.json().requestId).toBeDefined();
  });
});

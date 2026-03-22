import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../index.js";
import { createDb } from "../../db.js";
import { flags } from "../../schema.js";

/**
 * E2E tests — real HTTP server (not Fastify inject).
 * Uses server.listen() on a random port and native fetch().
 *
 * These tests verify the full network stack: TCP, HTTP parsing,
 * content negotiation, CORS headers — things that inject() skips.
 *
 * Requires: running Postgres (test DB).
 */

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
const API_KEY = "test-api-key";

beforeAll(async () => {
  server = await buildServer({
    db,
    cache: null,
    apiKey: API_KEY,
    rateLimit: false,
  });

  baseUrl = await server.listen({ port: 0 }); // random port;
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(flags);
});

const jsonHeaders = {
  "Content-Type": "application/json",
  "X-Api-Key": API_KEY,
};

/** Auth-only headers (no Content-Type) — for DELETE and other bodyless requests */
const authHeaders = {
  "X-Api-Key": API_KEY,
};

describe("full create → evaluate → toggle → delete flow", () => {
  it("completes the entire flag lifecycle over real HTTP", async () => {
    // 1. Create a flag
    const createRes = await fetch(`${baseUrl}/api/v1/flags`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ key: "e2e-flag", name: "E2E Flag", enabled: false }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.key).toBe("e2e-flag");
    expect(created.enabled).toBe(false);

    // 2. Evaluate — should be disabled
    const eval1 = await fetch(`${baseUrl}/api/v1/evaluate/e2e-flag`);
    expect(eval1.status).toBe(200);
    const evalBody1 = await eval1.json();
    expect(evalBody1.enabled).toBe(false);
    expect(evalBody1.source).toBe("database");

    // 3. Toggle to enabled
    const toggleRes = await fetch(`${baseUrl}/api/v1/flags/e2e-flag`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggleRes.status).toBe(200);
    expect((await toggleRes.json()).enabled).toBe(true);

    // 4. Evaluate — should be enabled now
    const eval2 = await fetch(`${baseUrl}/api/v1/evaluate/e2e-flag`);
    expect(eval2.status).toBe(200);
    expect((await eval2.json()).enabled).toBe(true);

    // 5. Delete — no Content-Type header (no body), only auth
    const deleteRes = await fetch(`${baseUrl}/api/v1/flags/e2e-flag`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(deleteRes.status).toBe(200);

    // 6. Evaluate after delete — 404
    const eval3 = await fetch(`${baseUrl}/api/v1/evaluate/e2e-flag`);
    expect(eval3.status).toBe(404);
  });

  it("returns x-request-id header on every response", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("rejects protected endpoint without API key over real HTTP", async () => {
    const res = await fetch(`${baseUrl}/api/v1/flags`, {
      headers: { "Content-Type": "application/json" },
      // no X-Api-Key
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });
});

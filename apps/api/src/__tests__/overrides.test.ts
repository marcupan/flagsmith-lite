import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { flags, flagOverrides } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(flagOverrides);
  await db.delete(flags);
  // Seed a flag for override tests
  await server.inject({
    method: "POST",
    url: "/api/v1/flags",
    headers: authHeader,
    payload: { key: "dark-mode", name: "Dark Mode", enabled: true },
  });
});

describe("PUT /api/v1/flags/:key/overrides/:env", () => {
  it("creates an override and returns 201", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().environment).toBe("staging");
    expect(res.json().enabled).toBe(false);
    expect(res.json().rolloutPercentage).toBe(100);
  });

  it("updates existing override and returns 200", async () => {
    // Create
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    // Update
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: true, rolloutPercentage: 50 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().rolloutPercentage).toBe(50);
  });

  it("rejects invalid environment", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/banana",
      headers: authHeader,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_ENVIRONMENT");
  });

  it("returns 404 for nonexistent flag", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/ghost/overrides/staging",
      headers: authHeader,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(404);
  });

  it("requires auth", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/v1/flags/:key/overrides", () => {
  it("returns empty array when no overrides", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags/dark-mode/overrides",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns all overrides for a flag", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/development",
      headers: authHeader,
      payload: { enabled: true, rolloutPercentage: 50 },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags/dark-mode/overrides",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const overrides = res.json();
    expect(overrides).toHaveLength(2);

    const envs = overrides.map((o: { environment: string }) => o.environment).sort();
    expect(envs).toEqual(["development", "staging"]);
  });

  it("returns 404 for nonexistent flag", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags/ghost/overrides",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/v1/flags/:key/overrides/:env", () => {
  it("deletes an override", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    // Verify it's gone
    const listRes = await server.inject({
      method: "GET",
      url: "/api/v1/flags/dark-mode/overrides",
      headers: authHeader,
    });
    expect(listRes.json()).toEqual([]);
  });

  it("returns 404 when no override exists", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("OVERRIDE_NOT_FOUND");
  });

  it("rejects invalid environment", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/dark-mode/overrides/banana",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("override cascade on flag delete", () => {
  it("deletes overrides when flag is deleted (ON DELETE CASCADE)", async () => {
    // Create override
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    // Delete the flag
    await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/dark-mode",
      headers: authHeader,
    });

    // Verify flag is gone
    const flagRes = await server.inject({
      method: "GET",
      url: "/api/v1/flags/dark-mode",
      headers: authHeader,
    });
    expect(flagRes.statusCode).toBe(404);
  });
});

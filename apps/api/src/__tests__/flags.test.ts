import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { flags } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  // Start each test with a clean flags table
  await db.delete(flags);
});

describe("GET /api/v1/flags", () => {
  it("returns empty array when no flags exist", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns 401 without API key", async () => {
    const res = await server.inject({ method: "GET", url: "/api/v1/flags" });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/v1/flags", () => {
  it("creates a flag and returns 201", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "my-feature", name: "My Feature", enabled: false },
    });

    expect(res.statusCode).toBe(201);

    const body = res.json();

    expect(body.key).toBe("my-feature");
    expect(body.enabled).toBe(false);
    expect(typeof body.id).toBe("number");
  });

  it("returns 409 when key already exists", async () => {
    const payload = { key: "dupe-key", name: "Dupe" };
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload,
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("FLAG_KEY_EXISTS");
  });

  it("returns 400 for invalid key format", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "UPPERCASE_NOT_ALLOWED", name: "Bad" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/flags/:key", () => {
  it("returns 404 for missing flag", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags/nonexistent",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("FLAG_NOT_FOUND");
  });

  it("returns the flag when it exists", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "test-flag", name: "Test", enabled: true },
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/flags/test-flag",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });
});

describe("PUT /api/v1/flags/:key", () => {
  it("updates a flag", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "toggle-me", name: "Toggle Me", enabled: false },
    });
    const res = await server.inject({
      method: "PUT",
      url: "/api/v1/flags/toggle-me",
      headers: authHeader,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });
});

describe("DELETE /api/v1/flags/:key", () => {
  it("deletes an existing flag", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "to-delete", name: "Delete Me" },
    });
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/to-delete",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it("returns 404 when deleting nonexistent flag", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/ghost",
      headers: authHeader,
    });

    expect(res.statusCode).toBe(404);
  });
});

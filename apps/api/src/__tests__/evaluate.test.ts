import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { flags } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
// Tests run without cache to validate a DB fallback path
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(flags);
});

describe("GET /api/v1/evaluate/:key", () => {
  it("returns 404 for unknown flag", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/unknown-flag",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("FLAG_NOT_FOUND");
  });

  it("returns enabled=false for a disabled flag", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "beta", name: "Beta", enabled: false },
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/beta",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(res.json().source).toBe("database");
  });

  it("returns enabled=true for an enabled flag", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "live", name: "Live", enabled: true },
    });
    const res = await server.inject({ method: "GET", url: "/api/v1/evaluate/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it("is accessible without API key (public endpoint)", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "public-check", name: "Public" },
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/public-check",
      // No auth header
    });
    expect(res.statusCode).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { API_VERSION } from "@project/shared";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

describe("GET /health", () => {
  it("returns 200 with correct payload shape", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe(API_VERSION);
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns x-request-id header", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("reflects x-request-id from request", async () => {
    const id = "my-trace-id-123";
    const res = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": id },
    });
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it("sets security headers via helmet", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

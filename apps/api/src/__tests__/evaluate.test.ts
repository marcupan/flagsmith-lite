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

  it("returns enabled=false for a disabled flag with reason flag_disabled", async () => {
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
    expect(res.json().reason).toBe("flag_disabled");
    expect(res.json().source).toBe("database");
  });

  it("returns enabled=true for an enabled flag with reason rollout_full", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "live", name: "Live", enabled: true },
    });
    const res = await server.inject({ method: "GET", url: "/api/v1/evaluate/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().reason).toBe("rollout_full");
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
    expect(res.json().reason).toBe("rollout_full");
  });
});

describe("GET /api/v1/evaluate/:key — percentage targeting", () => {
  it("returns rollout_match/rollout_miss based on userId", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "canary", name: "Canary", enabled: true, rolloutPercentage: 50 },
    });

    // Evaluate with different userIds — at least one should match and one should miss
    const results: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/evaluate/canary?userId=user-${i}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(["rollout_match", "rollout_miss"]).toContain(body.reason);
      results.push(body.enabled);
    }

    // At 50%, we expect a mix of true/false across 20 users
    expect(results).toContain(true);
    expect(results).toContain(false);
  });

  it("returns deterministic result for same userId", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "stable", name: "Stable", enabled: true, rolloutPercentage: 25 },
    });

    const res1 = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/stable?userId=user-42",
    });
    const res2 = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/stable?userId=user-42",
    });

    expect(res1.json().enabled).toBe(res2.json().enabled);
    expect(res1.json().reason).toBe(res2.json().reason);
  });

  it("falls back to enabled=true without userId on partial rollout", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "no-uid", name: "No UID", enabled: true, rolloutPercentage: 25 },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/no-uid",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().reason).toBe("no_user_id");
  });

  it("returns disabled when flag is disabled regardless of rollout", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "off-flag", name: "Off", enabled: false, rolloutPercentage: 100 },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/off-flag?userId=user-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(res.json().reason).toBe("flag_disabled");
  });
});

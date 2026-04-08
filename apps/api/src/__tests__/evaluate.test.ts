import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { flags, flagOverrides } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
// Tests run without cache to validate a DB fallback path
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(flagOverrides);
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
    expect(res.json().valueSource).toBe("default");
    expect(res.json().environment).toBe("production");
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
    expect(res.json().valueSource).toBe("default");
  });

  it("defaults to production environment when env not specified", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "env-test", name: "Env Test", enabled: true },
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/env-test",
    });
    expect(res.json().environment).toBe("production");
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

describe("GET /api/v1/evaluate/:key — environment overrides", () => {
  it("uses override when evaluating in overridden environment", async () => {
    // Create flag enabled by default
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "new-checkout", name: "New Checkout", enabled: true },
    });

    // Override: disable on staging
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/new-checkout/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    // Evaluate on production → default (enabled)
    const prodRes = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/new-checkout?env=production",
    });
    expect(prodRes.json().enabled).toBe(true);
    expect(prodRes.json().valueSource).toBe("default");
    expect(prodRes.json().environment).toBe("production");

    // Evaluate on staging → override (disabled)
    const stagingRes = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/new-checkout?env=staging",
    });
    expect(stagingRes.json().enabled).toBe(false);
    expect(stagingRes.json().valueSource).toBe("override");
    expect(stagingRes.json().environment).toBe("staging");
    expect(stagingRes.json().reason).toBe("flag_disabled");
  });

  it("falls back to flag default when no override exists for environment", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "fallback-test", name: "Fallback", enabled: true },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/fallback-test?env=development",
    });

    expect(res.json().enabled).toBe(true);
    expect(res.json().valueSource).toBe("default");
    expect(res.json().environment).toBe("development");
  });

  it("override rolloutPercentage works with targeting", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "ab-test", name: "AB Test", enabled: true, rolloutPercentage: 100 },
    });

    // Override staging to 50% rollout
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/ab-test/overrides/staging",
      headers: authHeader,
      payload: { enabled: true, rolloutPercentage: 50 },
    });

    // Production: 100% rollout → always enabled
    const prodRes = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/ab-test?env=production&userId=user-1",
    });
    expect(prodRes.json().enabled).toBe(true);
    expect(prodRes.json().reason).toBe("rollout_full");

    // Staging: 50% rollout → mix of results
    const results: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/evaluate/ab-test?env=staging&userId=user-${i}`,
      });
      results.push(res.json().enabled);
    }
    expect(results).toContain(true);
    expect(results).toContain(false);
  });

  it("treats invalid env as production (backward compatible)", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "bad-env", name: "Bad Env", enabled: true },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/bad-env?env=nonexistent",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().environment).toBe("production");
    expect(res.json().valueSource).toBe("default");
  });
});

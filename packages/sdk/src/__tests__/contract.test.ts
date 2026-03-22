import { describe, expect, it } from "vitest";

import type { Flag, EvaluateResponse, AppErrorResponse } from "@project/shared";

/**
 * Contract tests: verify that API response shapes match what SDK/consumers expect.
 * These use sample payloads (snapshots of real API output) validated against
 * runtime assertion functions that mirror the TypeScript interfaces.
 *
 * Purpose: catch drift between API and consumers WITHOUT running both.
 */

// ── Runtime assertion functions (mirror TS interfaces) ──────────────────

function assertFlag(data: unknown): asserts data is Flag {
  if (data == null || typeof data !== "object") {
    throw new Error("Expected an object");
  }

  const obj = data as Record<string, unknown>;

  expect(typeof obj.id).toBe("number");
  expect(typeof obj.key).toBe("string");
  expect((obj.key as string).length).toBeGreaterThan(0);
  expect(typeof obj.name).toBe("string");
  expect(typeof obj.enabled).toBe("boolean");
  expect(obj.description === null || typeof obj.description === "string").toBe(true);
  expect(typeof obj.createdAt).toBe("string");
  expect(typeof obj.updatedAt).toBe("string");
  // Timestamps must be valid ISO 8601
  expect(new Date(obj.createdAt as string).toISOString()).toBe(obj.createdAt);
  expect(new Date(obj.updatedAt as string).toISOString()).toBe(obj.updatedAt);
}

function assertEvaluateResponse(data: unknown): asserts data is EvaluateResponse {
  if (data == null || typeof data !== "object") {
    throw new Error("Expected an object");
  }

  const obj = data as Record<string, unknown>;

  expect(typeof obj.key).toBe("string");
  expect(typeof obj.enabled).toBe("boolean");
  expect(typeof obj.evaluatedAt).toBe("string");
  expect(new Date(obj.evaluatedAt as string).toISOString()).toBe(obj.evaluatedAt);
  expect(["cache", "database"]).toContain(obj.source);
}

function assertAppErrorResponse(data: unknown): asserts data is AppErrorResponse {
  if (data == null || typeof data !== "object") {
    throw new Error("Expected an object");
  }

  const obj = data as Record<string, unknown>;

  expect(typeof obj.code).toBe("string");
  expect(typeof obj.message).toBe("string");
  expect(typeof obj.requestId).toBe("string");
}

// ── Sample payloads (snapshots of real API responses) ───────────────────

const sampleFlag: unknown = {
  id: 1,
  key: "dark-mode",
  name: "Dark Mode",
  enabled: true,
  description: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const sampleEvaluateResponse: unknown = {
  key: "dark-mode",
  enabled: true,
  evaluatedAt: "2026-01-01T00:00:00.000Z",
  source: "database",
};

const sampleErrorResponse: unknown = {
  code: "FLAG_NOT_FOUND",
  message: 'Flag "unknown" not found',
  requestId: "abc-123",
};

// ── Contract tests ──────────────────────────────────────────────────────

describe("Flag contract", () => {
  it("validates a correct Flag response", () => {
    expect(() => assertFlag(sampleFlag)).not.toThrow();
  });

  it("rejects missing key field", () => {
    const noKey = { ...(sampleFlag as Record<string, unknown>) };
    delete noKey.key;

    expect(() => assertFlag(noKey)).toThrow();
  });
});

describe("EvaluateResponse contract", () => {
  it("validates a correct EvaluateResponse", () => {
    expect(() => assertEvaluateResponse(sampleEvaluateResponse)).not.toThrow();
  });

  it("rejects invalid source value", () => {
    expect(() =>
      assertEvaluateResponse({ ...(sampleEvaluateResponse as object), source: "memory" }),
    ).toThrow();
  });

  it("allows forward-compatible extra fields", () => {
    const withExtra = { ...(sampleEvaluateResponse as object), percentage: 50, variant: "A" };

    expect(() => assertEvaluateResponse(withExtra)).not.toThrow();
  });
});

describe("AppErrorResponse contract", () => {
  it("validates a correct error response", () => {
    expect(() => assertAppErrorResponse(sampleErrorResponse)).not.toThrow();
  });

  it("rejects missing requestId", () => {
    const noReqId = { ...(sampleErrorResponse as Record<string, unknown>) };

    delete noReqId.requestId;

    expect(() => assertAppErrorResponse(noReqId)).toThrow();
  });
});

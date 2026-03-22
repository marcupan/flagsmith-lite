import { describe, expect, it } from "vitest";

import { createError, ErrorCodes } from "../index.js";

describe("ErrorCodes", () => {
  it("has status and message for every code", () => {
    for (const [code, def] of Object.entries(ErrorCodes)) {
      expect(def).toHaveProperty("status");
      expect(def).toHaveProperty("message");
      expect(typeof def.status).toBe("number");
      expect(typeof def.message).toBe("string");
      expect(code).toBeTruthy();
    }
  });
});

describe("createError", () => {
  it("returns correct status for FLAG_NOT_FOUND", () => {
    const err = createError("FLAG_NOT_FOUND");

    expect(err.code).toBe("FLAG_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Flag not found");
  });

  it("returns correct status for FLAG_KEY_EXISTS", () => {
    const err = createError("FLAG_KEY_EXISTS");

    expect(err.status).toBe(409);
  });

  it("returns correct status for VALIDATION_ERROR", () => {
    const err = createError("VALIDATION_ERROR");

    expect(err.status).toBe(400);
  });

  it("returns correct status for UNAUTHORIZED", () => {
    const err = createError("UNAUTHORIZED");

    expect(err.status).toBe(401);
  });

  it("returns correct status for INTERNAL_ERROR", () => {
    const err = createError("INTERNAL_ERROR");

    expect(err.status).toBe(500);
  });

  it("returns correct status for SERVICE_UNAVAILABLE", () => {
    const err = createError("SERVICE_UNAVAILABLE");

    expect(err.status).toBe(503);
  });

  it("uses override message when provided", () => {
    const err = createError("FLAG_NOT_FOUND", 'Flag "x" not found');

    expect(err.message).toBe('Flag "x" not found');
    expect(err.status).toBe(404); // status unchanged
  });

  it("returns { code, message, status } shape", () => {
    const err = createError("INTERNAL_ERROR");

    expect(Object.keys(err).sort()).toEqual(["code", "message", "status"]);
  });
});

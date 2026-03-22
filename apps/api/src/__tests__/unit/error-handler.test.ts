import { describe, expect, it } from "vitest";
import { resolveErrorResponse } from "../../error-handler.js";
import { AppError } from "../../errors.js";

describe("resolveErrorResponse", () => {
  it("maps AppError to its status and code", () => {
    const error = new AppError("FLAG_NOT_FOUND", 'Flag "x" not found', 404);
    const result = resolveErrorResponse(error);

    expect(result.statusCode).toBe(404);
    expect(result.code).toBe("FLAG_NOT_FOUND");
    // Client errors show the actual message
    expect(result.message).toBe('Flag "x" not found');
  });

  it("maps generic Error to 500 + INTERNAL_ERROR", () => {
    const error = new Error("something broke");
    const result = resolveErrorResponse(error);

    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    // 500 errors hide the real message from the client
    expect(result.message).toBe("Internal server error");
  });

  it("maps Fastify validation error (statusCode 400) to VALIDATION_ERROR", () => {
    // Fastify attaches statusCode to validation errors
    const error = Object.assign(new Error("body/key must be string"), {
      statusCode: 400,
    });
    const result = resolveErrorResponse(error);

    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.message).toBe("body/key must be string");
  });

  it("uses error.code when present (even for client errors)", () => {
    const error = Object.assign(new Error("conflict"), {
      statusCode: 409,
      code: "FLAG_KEY_EXISTS",
    });
    const result = resolveErrorResponse(error);

    expect(result.code).toBe("FLAG_KEY_EXISTS");
  });

  it("defaults to 500 when error has no statusCode", () => {
    const result = resolveErrorResponse({ weird: "object" });

    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
  });

  it("handles null/undefined error gracefully", () => {
    const result = resolveErrorResponse(null);

    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

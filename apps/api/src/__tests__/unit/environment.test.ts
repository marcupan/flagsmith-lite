import { describe, expect, it } from "vitest";

import { ENVIRONMENTS, isEnvironment } from "@project/shared";

describe("isEnvironment", () => {
  it("accepts valid environments", () => {
    for (const env of ENVIRONMENTS) {
      expect(isEnvironment(env)).toBe(true);
    }
  });

  it("rejects invalid strings", () => {
    expect(isEnvironment("banana")).toBe(false);
    expect(isEnvironment("prod")).toBe(false);
    expect(isEnvironment("")).toBe(false);
    expect(isEnvironment("PRODUCTION")).toBe(false);
  });

  it("includes all three expected environments", () => {
    expect(ENVIRONMENTS).toContain("development");
    expect(ENVIRONMENTS).toContain("staging");
    expect(ENVIRONMENTS).toContain("production");
    expect(ENVIRONMENTS).toHaveLength(3);
  });
});

import { describe, expect, it } from "vitest";
import { toFlagResponse } from "../../mappers.js";

/** Minimal DB row shape matching Drizzle's $inferSelect for the flags table. */
function makeRow(overrides: Partial<Parameters<typeof toFlagResponse>[0]> = {}) {
  return {
    id: 1,
    key: "dark-mode",
    name: "Dark Mode",
    enabled: true,
    description: "Toggle dark theme",
    createdAt: new Date("2026-01-15T12:00:00Z"),
    updatedAt: new Date("2026-01-15T13:00:00Z"),
    ...overrides,
  };
}

describe("toFlagResponse", () => {
  it("converts Date objects to ISO 8601 strings", () => {
    const result = toFlagResponse(makeRow());

    expect(result.createdAt).toBe("2026-01-15T12:00:00.000Z");
    expect(result.updatedAt).toBe("2026-01-15T13:00:00.000Z");
  });

  it("preserves all scalar fields", () => {
    const result = toFlagResponse(makeRow());

    expect(result.id).toBe(1);
    expect(result.key).toBe("dark-mode"); // branded FlagKey, but same runtime value
    expect(result.name).toBe("Dark Mode");
    expect(result.enabled).toBe(true);
    expect(result.description).toBe("Toggle dark theme");
  });

  it("handles null description", () => {
    const result = toFlagResponse(makeRow({ description: null }));

    expect(result.description).toBeNull();
  });

  it("handles disabled flag", () => {
    const result = toFlagResponse(makeRow({ enabled: false }));

    expect(result.enabled).toBe(false);
  });

  it("brands the key as FlagKey (runtime value unchanged)", () => {
    const result = toFlagResponse(makeRow({ key: "feature-123" }));

    // At runtime, a branded type is just a string
    const asString: string = result.key;
    expect(asString).toBe("feature-123");
  });
});

import { describe, expect, it } from "vitest";

import { FlagKey, Timestamp } from "../branded.js";

describe("FlagKey", () => {
  it.each(["dark-mode", "ab", "feature-123", "a", "my_flag", "0-start"])(
    "accepts valid key: %s",
    (raw) => {
      expect(() => FlagKey(raw)).not.toThrow();
      expect(FlagKey(raw)).toBe(raw); // branded value === raw string at runtime
    },
  );

  it.each(["UPPERCASE", "-start-dash", "", "a b c", "flag!!", "A".repeat(129)])(
    "rejects invalid key: %s",
    (raw) => {
      expect(() => FlagKey(raw)).toThrow(/Invalid flag key/);
    },
  );

  it("returns a value assignable to string", () => {
    const str: string = FlagKey("valid-key"); // branded → string is allowed

    expect(str).toBe("valid-key");
  });
});

describe("Timestamp", () => {
  it("returns an ISO 8601 string from a Date", () => {
    const date = new Date("2026-01-15T12:00:00Z");
    const ts = Timestamp(date);

    expect(ts).toBe("2026-01-15T12:00:00.000Z");
  });

  it("returns current time when called without args", () => {
    const before = Date.now();
    const ts = Timestamp();
    const after = Date.now();
    const parsed = Date.parse(ts);

    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("is a valid ISO 8601 string", () => {
    const ts = Timestamp(new Date("2026-03-22T10:30:00Z"));

    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});

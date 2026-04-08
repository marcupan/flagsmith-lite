import { describe, expect, it } from "vitest";
import { diffChanges, hashActor } from "../../audit.js";

describe("hashActor", () => {
  it("returns an 8-character hex string", () => {
    const result = hashActor("my-secret-api-key");
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashActor("test-key");
    const b = hashActor("test-key");
    expect(a).toBe(b);
  });

  it("produces different hashes for different keys", () => {
    const a = hashActor("key-alpha");
    const b = hashActor("key-beta");
    expect(a).not.toBe(b);
  });

  it("does not return the original key", () => {
    const key = "my-api-key";
    const result = hashActor(key);
    expect(key).not.toContain(result);
    expect(result).not.toContain(key);
  });
});

describe("diffChanges", () => {
  it("detects changed fields", () => {
    const before = { enabled: false, name: "Old" };
    const after = { enabled: true, name: "Old" };
    const diff = diffChanges(before, after);

    expect(diff).toEqual({
      enabled: { from: false, to: true },
    });
  });

  it("detects added fields (before empty)", () => {
    const diff = diffChanges({}, { key: "dark-mode", enabled: true });

    expect(diff).toEqual({
      key: { from: null, to: "dark-mode" },
      enabled: { from: null, to: true },
    });
  });

  it("detects removed fields (after empty — deletion)", () => {
    const diff = diffChanges({ key: "dark-mode", enabled: true }, {});

    expect(diff).toEqual({
      key: { from: "dark-mode", to: null },
      enabled: { from: true, to: null },
    });
  });

  it("returns empty diff when objects are equal", () => {
    const obj = { enabled: true, name: "Same" };
    const diff = diffChanges(obj, { ...obj });

    expect(diff).toEqual({});
  });

  it("handles nested objects via JSON comparison", () => {
    const before = { config: { a: 1, b: 2 } };
    const after = { config: { a: 1, b: 3 } };
    const diff = diffChanges(before, after);

    expect(diff).toEqual({
      config: { from: { a: 1, b: 2 }, to: { a: 1, b: 3 } },
    });
  });

  it("handles null values correctly", () => {
    const before = { description: null };
    const after = { description: "New description" };
    const diff = diffChanges(before, after);

    expect(diff).toEqual({
      description: { from: null, to: "New description" },
    });
  });

  it("handles null → null as no change", () => {
    const diff = diffChanges({ description: null }, { description: null });
    expect(diff).toEqual({});
  });

  it("handles both added and removed fields simultaneously", () => {
    const before = { oldField: "old", shared: "same" };
    const after = { newField: "new", shared: "same" };
    const diff = diffChanges(before, after);

    expect(diff).toEqual({
      newField: { from: null, to: "new" },
      oldField: { from: "old", to: null },
    });
  });

  it("detects number changes (rolloutPercentage pattern)", () => {
    const diff = diffChanges({ rolloutPercentage: 100 }, { rolloutPercentage: 50 });

    expect(diff).toEqual({
      rolloutPercentage: { from: 100, to: 50 },
    });
  });
});

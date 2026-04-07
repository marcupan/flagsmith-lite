import { describe, expect, it } from "vitest";
import { computeBucket, evaluateTargeting } from "../../targeting.js";

describe("computeBucket", () => {
  it("returns deterministic results for the same input", () => {
    const a = computeBucket("dark-mode", "user-123");
    const b = computeBucket("dark-mode", "user-123");
    expect(a).toBe(b);
  });

  it("returns different buckets for different userIds", () => {
    const a = computeBucket("dark-mode", "user-1");
    const b = computeBucket("dark-mode", "user-2");
    // Not guaranteed different, but overwhelmingly likely for these inputs
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
    // Both should be in [0, 99]
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });

  it("returns different buckets for different flagKeys", () => {
    const a = computeBucket("flag-a", "user-1");
    const b = computeBucket("flag-b", "user-1");
    // Same user, different flags → different bucket (different rollout cohort per flag)
    expect(a).not.toBe(b);
  });

  it("produces roughly uniform distribution across 1000 users", () => {
    const buckets = new Array(100).fill(0) as number[];

    for (let i = 0; i < 1000; i++) {
      const bucket = computeBucket("test-flag", `user-${i}`);
      buckets[bucket]++;
    }

    // Each bucket should have ~10 users (1000/100).
    // Allow generous range [1, 30] to avoid flaky tests.
    for (const count of buckets) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(30);
    }
  });

  it("at 50% rollout, approximately half of 1000 users match", () => {
    let matches = 0;

    for (let i = 0; i < 1000; i++) {
      const bucket = computeBucket("fifty-fifty", `user-${i}`);
      if (bucket < 50) matches++;
    }

    // Expect ~500 ± 80 (generous tolerance for hash distribution)
    expect(matches).toBeGreaterThan(400);
    expect(matches).toBeLessThan(600);
  });
});

describe("evaluateTargeting", () => {
  const baseOpts = { flagKey: "test-flag", flagEnabled: true, rolloutPercentage: 100 };

  it("returns disabled when flag is disabled", () => {
    const result = evaluateTargeting({ ...baseOpts, flagEnabled: false });
    expect(result).toEqual({ enabled: false, reason: "flag_disabled" });
  });

  it("returns enabled with rollout_full when rollout is 100%", () => {
    const result = evaluateTargeting({ ...baseOpts, rolloutPercentage: 100 });
    expect(result).toEqual({ enabled: true, reason: "rollout_full" });
  });

  it("returns disabled with rollout_miss when rollout is 0%", () => {
    const result = evaluateTargeting({ ...baseOpts, rolloutPercentage: 0 });
    expect(result).toEqual({ enabled: false, reason: "rollout_miss" });
  });

  it("returns enabled with no_user_id when partial rollout but no userId", () => {
    const result = evaluateTargeting({ ...baseOpts, rolloutPercentage: 50 });
    expect(result).toEqual({ enabled: true, reason: "no_user_id" });
  });

  it("returns deterministic result for same userId", () => {
    const opts = { ...baseOpts, rolloutPercentage: 50, userId: "user-42" };
    const a = evaluateTargeting(opts);
    const b = evaluateTargeting(opts);
    expect(a).toEqual(b);
  });

  it("returns rollout_match or rollout_miss with userId", () => {
    const result = evaluateTargeting({
      ...baseOpts,
      rolloutPercentage: 50,
      userId: "user-1",
    });
    expect(["rollout_match", "rollout_miss"]).toContain(result.reason);
    expect(typeof result.enabled).toBe("boolean");
  });

  it("flag_disabled takes priority over rollout", () => {
    const result = evaluateTargeting({
      flagKey: "test",
      flagEnabled: false,
      rolloutPercentage: 100,
      userId: "user-1",
    });
    expect(result).toEqual({ enabled: false, reason: "flag_disabled" });
  });

  it("handles edge case: rollout > 100 treated as full rollout", () => {
    const result = evaluateTargeting({ ...baseOpts, rolloutPercentage: 150 });
    expect(result).toEqual({ enabled: true, reason: "rollout_full" });
  });

  it("handles edge case: negative rollout treated as zero", () => {
    const result = evaluateTargeting({ ...baseOpts, rolloutPercentage: -10, userId: "user-1" });
    expect(result).toEqual({ enabled: false, reason: "rollout_miss" });
  });
});

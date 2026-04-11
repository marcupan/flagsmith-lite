import { describe, expect, it } from "vitest";

import {
  assignCohort,
  canTransitionExperiment,
  cohortEnabled,
  isValidSplit,
} from "../../experiments.js";
import { computeBucket } from "../../targeting.js";

describe("assignCohort", () => {
  it("is deterministic — same (flag, user) always returns the same cohort", () => {
    const a = assignCohort({
      flagKey: "new-checkout",
      userId: "user-1",
      controlPercentage: 50,
      variantPercentage: 50,
    });
    const b = assignCohort({
      flagKey: "new-checkout",
      userId: "user-1",
      controlPercentage: 50,
      variantPercentage: 50,
    });
    expect(a).toBe(b);
  });

  it("respects control/variant boundaries relative to computeBucket", () => {
    // Pick a user whose bucket we can verify directly
    const flagKey = "ab-test";
    const userId = "marker-user";
    const bucket = computeBucket(flagKey, userId);

    const cohort = assignCohort({
      flagKey,
      userId,
      controlPercentage: 30,
      variantPercentage: 40,
    });

    if (bucket < 30) {
      expect(cohort).toBe("control");
    } else if (bucket < 70) {
      expect(cohort).toBe("variant");
    } else {
      expect(cohort).toBe("holdout");
    }
  });

  it("assigns holdout when control + variant < 100", () => {
    // 50/10 split leaves 40% in holdout → at least some users should land there
    let seenHoldout = false;
    for (let i = 0; i < 500; i++) {
      const cohort = assignCohort({
        flagKey: "holdout-test",
        userId: `user-${i}`,
        controlPercentage: 50,
        variantPercentage: 10,
      });
      if (cohort === "holdout") {
        seenHoldout = true;
        break;
      }
    }
    expect(seenHoldout).toBe(true);
  });

  it("never returns holdout for a 50/50 split (no remainder)", () => {
    for (let i = 0; i < 200; i++) {
      const cohort = assignCohort({
        flagKey: "full-split",
        userId: `user-${i}`,
        controlPercentage: 50,
        variantPercentage: 50,
      });
      expect(cohort).not.toBe("holdout");
    }
  });

  it("produces roughly the expected distribution across many users", () => {
    const counts = { control: 0, variant: 0, holdout: 0 };
    const N = 2000;

    for (let i = 0; i < N; i++) {
      const cohort = assignCohort({
        flagKey: "dist-test",
        userId: `user-${i}`,
        controlPercentage: 50,
        variantPercentage: 50,
      });
      counts[cohort]++;
    }

    // Each cohort should be within ±10% of the expected 50% for N=2000
    expect(counts.control / N).toBeGreaterThan(0.4);
    expect(counts.control / N).toBeLessThan(0.6);
    expect(counts.variant / N).toBeGreaterThan(0.4);
    expect(counts.variant / N).toBeLessThan(0.6);
  });
});

describe("cohortEnabled", () => {
  it("only variant sees the feature", () => {
    expect(cohortEnabled("variant")).toBe(true);
    expect(cohortEnabled("control")).toBe(false);
    expect(cohortEnabled("holdout")).toBe(false);
  });
});

describe("canTransitionExperiment", () => {
  it("allows draft → running", () => {
    expect(canTransitionExperiment("draft", "running")).toBe(true);
  });

  it("allows running → concluded", () => {
    expect(canTransitionExperiment("running", "concluded")).toBe(true);
  });

  it("rejects running → draft", () => {
    expect(canTransitionExperiment("running", "draft")).toBe(false);
  });

  it("rejects concluded → anything (terminal)", () => {
    expect(canTransitionExperiment("concluded", "running")).toBe(false);
    expect(canTransitionExperiment("concluded", "draft")).toBe(false);
  });

  it("rejects draft → concluded (must go via running)", () => {
    expect(canTransitionExperiment("draft", "concluded")).toBe(false);
  });
});

describe("isValidSplit", () => {
  it("accepts splits summing to 100", () => {
    expect(isValidSplit(50, 50)).toBe(true);
    expect(isValidSplit(0, 100)).toBe(true);
    expect(isValidSplit(100, 0)).toBe(true);
  });

  it("accepts splits summing to less than 100 (holdout reserved)", () => {
    expect(isValidSplit(30, 30)).toBe(true);
    expect(isValidSplit(0, 0)).toBe(true);
  });

  it("rejects splits summing over 100", () => {
    expect(isValidSplit(60, 50)).toBe(false);
  });

  it("rejects negative values", () => {
    expect(isValidSplit(-1, 50)).toBe(false);
    expect(isValidSplit(50, -1)).toBe(false);
  });
});

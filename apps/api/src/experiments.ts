/**
 * Experiment service — cohort assignment and lifecycle guards.
 *
 * Pure functions only (no I/O). Keep this module easy to unit-test;
 * database access lives in the routes layer.
 *
 * Cohort assignment reuses `computeBucket()` from `targeting.ts`, so a user
 * that hashes into bucket 37 for flag "new-checkout" will *always* land in
 * the same cohort — as long as the experiment's split percentages don't
 * change. That determinism is what lets us split user sessions without
 * server-side state.
 */
import type { ExperimentCohort, ExperimentStatus } from "@project/shared";

import { computeBucket } from "./targeting.js";

/**
 * Assign a user to a cohort given an experiment split.
 *
 * Algorithm:
 *   bucket = hash(flagKey + userId) % 100
 *   if bucket < control                 → "control"   (flag disabled)
 *   else if bucket < control + variant  → "variant"   (flag enabled)
 *   else                                → "holdout"   (excluded, flag disabled)
 *
 * `holdout` lets us reserve a portion of users that neither see the feature
 * nor count toward the control baseline — useful for long-running A/B tests
 * where you want a clean unexposed population.
 */
export function assignCohort(opts: {
  flagKey: string;
  userId: string;
  controlPercentage: number;
  variantPercentage: number;
}): ExperimentCohort {
  const bucket = computeBucket(opts.flagKey, opts.userId);

  if (bucket < opts.controlPercentage) {
    return "control";
  }

  if (bucket < opts.controlPercentage + opts.variantPercentage) {
    return "variant";
  }

  return "holdout";
}

/**
 * Map cohort → flag enabled boolean.
 * Only "variant" sees the feature; "control" and "holdout" do not.
 */
export function cohortEnabled(cohort: ExperimentCohort): boolean {
  return cohort === "variant";
}

/**
 * Validate an experiment state transition.
 *
 * State machine:
 *   draft     → running    (on /start)
 *   running   → concluded  (on /conclude)
 *   concluded → (terminal — no outgoing edges)
 */
export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus): boolean {
  if (from === "draft" && to === "running") {
    return true;
  }

  return from === "running" && to === "concluded";
}

/**
 * Validate that control + variant split is in [0, 100].
 * Remaining percentage (if any) is the holdout cohort.
 */
export function isValidSplit(controlPercentage: number, variantPercentage: number): boolean {
  if (controlPercentage < 0 || variantPercentage < 0) {
    return false;
  }

  const total = controlPercentage + variantPercentage;

  return total >= 0 && total <= 100;
}

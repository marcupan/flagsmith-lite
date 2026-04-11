import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EvaluateResponse, Experiment, ExperimentResultsResponse } from "@project/shared";

import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { auditEvents, experiments, flagOverrides, flags } from "../schema.js";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  // Order matters: experiments references flags(key), flagOverrides references flags(id)
  await db.delete(experiments);
  await db.delete(flagOverrides);
  await db.delete(flags);
  await db.delete(auditEvents);
});

/** Create a flag via the API so audit + webhook plumbing runs too. */
async function createFlag(key: string): Promise<void> {
  const res = await server.inject({
    method: "POST",
    url: "/api/v1/flags",
    headers: authHeader,
    payload: { key, name: `${key} flag` },
  });
  expect(res.statusCode).toBe(201);
}

async function createExperiment(payload: Record<string, unknown>): Promise<Experiment> {
  const res = await server.inject({
    method: "POST",
    url: "/api/v1/experiments",
    headers: authHeader,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Experiment;
}

describe("experiments CRUD", () => {
  it("creates a draft experiment with default 50/50 split", async () => {
    await createFlag("new-pricing");
    const exp = await createExperiment({
      flagKey: "new-pricing",
      name: "Pricing A/B",
      hypothesis: "New pricing improves signups by 10%",
      primaryMetric: "signup_completed",
    });

    expect(exp.status).toBe("draft");
    expect(exp.controlPercentage).toBe(50);
    expect(exp.variantPercentage).toBe(50);
    expect(exp.startDate).toBeNull();
    expect(exp.endDate).toBeNull();
    expect(exp.conclusion).toBeNull();
  });

  it("rejects creation when referenced flag does not exist", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/experiments",
      headers: authHeader,
      payload: {
        flagKey: "does-not-exist",
        name: "x",
        hypothesis: "y",
        primaryMetric: "z",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects split when control + variant > 100", async () => {
    await createFlag("bad-split");
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/experiments",
      headers: authHeader,
      payload: {
        flagKey: "bad-split",
        name: "x",
        hypothesis: "y",
        primaryMetric: "z",
        controlPercentage: 60,
        variantPercentage: 50,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists experiments filtered by status", async () => {
    await createFlag("flag-a");
    await createFlag("flag-b");
    await createExperiment({
      flagKey: "flag-a",
      name: "A",
      hypothesis: "h",
      primaryMetric: "m",
    });
    await createExperiment({
      flagKey: "flag-b",
      name: "B",
      hypothesis: "h",
      primaryMetric: "m",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/experiments?status=draft",
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Experiment[];
    expect(list).toHaveLength(2);
    expect(list.every((e) => e.status === "draft")).toBe(true);
  });
});

describe("experiment lifecycle", () => {
  it("transitions draft → running → concluded and updates the flag", async () => {
    await createFlag("lifecycle");
    const exp = await createExperiment({
      flagKey: "lifecycle",
      name: "Lifecycle",
      hypothesis: "h",
      primaryMetric: "m",
      controlPercentage: 40,
      variantPercentage: 40,
    });

    // Start
    const startRes = await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/start`,
      headers: authHeader,
    });
    expect(startRes.statusCode).toBe(200);
    const started = startRes.json() as Experiment;
    expect(started.status).toBe("running");
    expect(started.startDate).toBeTruthy();

    // Flag should now be enabled at variant%
    const flagRes = await server.inject({
      method: "GET",
      url: "/api/v1/flags/lifecycle",
      headers: authHeader,
    });
    const flag = flagRes.json() as { enabled: boolean; rolloutPercentage: number };
    expect(flag.enabled).toBe(true);
    expect(flag.rolloutPercentage).toBe(40);

    // Conclude with ship
    const concludeRes = await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/conclude`,
      headers: authHeader,
      payload: { conclusion: "ship", notes: "15.2% lift" },
    });
    expect(concludeRes.statusCode).toBe(200);
    const concluded = concludeRes.json() as Experiment;
    expect(concluded.status).toBe("concluded");
    expect(concluded.conclusion).toBe("ship");
    expect(concluded.endDate).toBeTruthy();

    // After ship: flag at 100%
    const finalFlagRes = await server.inject({
      method: "GET",
      url: "/api/v1/flags/lifecycle",
      headers: authHeader,
    });
    const finalFlag = finalFlagRes.json() as { enabled: boolean; rolloutPercentage: number };
    expect(finalFlag.rolloutPercentage).toBe(100);
  });

  it("rollback conclusion disables the flag", async () => {
    await createFlag("rollback-test");
    const exp = await createExperiment({
      flagKey: "rollback-test",
      name: "RB",
      hypothesis: "h",
      primaryMetric: "m",
    });

    await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/start`,
      headers: authHeader,
    });
    await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/conclude`,
      headers: authHeader,
      payload: { conclusion: "rollback" },
    });

    const flagRes = await server.inject({
      method: "GET",
      url: "/api/v1/flags/rollback-test",
      headers: authHeader,
    });
    const flag = flagRes.json() as { enabled: boolean };
    expect(flag.enabled).toBe(false);
  });

  it("rejects start when another experiment on the same flag is running", async () => {
    await createFlag("conflict-flag");
    const first = await createExperiment({
      flagKey: "conflict-flag",
      name: "First",
      hypothesis: "h",
      primaryMetric: "m",
    });
    const second = await createExperiment({
      flagKey: "conflict-flag",
      name: "Second",
      hypothesis: "h",
      primaryMetric: "m",
    });

    await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${first.id}/start`,
      headers: authHeader,
    });

    const conflictRes = await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${second.id}/start`,
      headers: authHeader,
    });
    expect(conflictRes.statusCode).toBe(409);
  });

  it("rejects updates once the experiment is running", async () => {
    await createFlag("frozen");
    const exp = await createExperiment({
      flagKey: "frozen",
      name: "Frozen",
      hypothesis: "h",
      primaryMetric: "m",
    });
    await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/start`,
      headers: authHeader,
    });

    const res = await server.inject({
      method: "PUT",
      url: `/api/v1/experiments/${exp.id}`,
      headers: authHeader,
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects conclude when experiment is still in draft", async () => {
    await createFlag("still-draft");
    const exp = await createExperiment({
      flagKey: "still-draft",
      name: "D",
      hypothesis: "h",
      primaryMetric: "m",
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/conclude`,
      headers: authHeader,
      payload: { conclusion: "ship" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("evaluate with running experiment", () => {
  async function startExperiment(flagKey: string, controlPct = 50, variantPct = 50): Promise<void> {
    await createFlag(flagKey);
    const exp = await createExperiment({
      flagKey,
      name: `${flagKey} test`,
      hypothesis: "h",
      primaryMetric: "m",
      controlPercentage: controlPct,
      variantPercentage: variantPct,
    });
    const startRes = await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/start`,
      headers: authHeader,
    });
    expect(startRes.statusCode).toBe(200);
  }

  it("returns cohort assignment in the evaluate response when userId is supplied", async () => {
    await startExperiment("cohort-eval");

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/cohort-eval?userId=user-abc",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EvaluateResponse;
    expect(body.experiment).toBeDefined();
    expect(["control", "variant", "holdout"]).toContain(body.experiment?.cohort);
    expect(["experiment_control", "experiment_variant", "experiment_holdout"]).toContain(
      body.reason,
    );
  });

  it("assigns the same user to the same cohort across repeated evaluations", async () => {
    await startExperiment("sticky-eval", 50, 50);

    const a = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/sticky-eval?userId=sticky-user",
    });
    const b = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/sticky-eval?userId=sticky-user",
    });

    const bodyA = a.json() as EvaluateResponse;
    const bodyB = b.json() as EvaluateResponse;
    expect(bodyA.experiment?.cohort).toBe(bodyB.experiment?.cohort);
  });

  it("different users land in different cohorts across a batch", async () => {
    await startExperiment("split-eval", 50, 50);

    const cohorts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = await server.inject({
        method: "GET",
        url: `/api/v1/evaluate/split-eval?userId=user-${i}`,
      });
      const body = res.json() as EvaluateResponse;
      if (body.experiment?.cohort) cohorts.add(body.experiment.cohort);
      if (cohorts.size >= 2) break;
    }
    expect(cohorts.size).toBeGreaterThanOrEqual(2);
  });

  it("falls back to percentage targeting when userId is missing", async () => {
    await startExperiment("no-user");

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/evaluate/no-user",
    });
    const body = res.json() as EvaluateResponse;
    // Without userId, cohort assignment is skipped → no experiment block
    expect(body.experiment).toBeUndefined();
  });
});

describe("experiment results endpoint", () => {
  it("returns cohort evaluation counts after running evaluations", async () => {
    await createFlag("results-flag");
    const exp = await createExperiment({
      flagKey: "results-flag",
      name: "Results",
      hypothesis: "h",
      primaryMetric: "m",
    });
    await server.inject({
      method: "POST",
      url: `/api/v1/experiments/${exp.id}/start`,
      headers: authHeader,
    });

    // Drive a bunch of evaluations so Prometheus counters increment
    for (let i = 0; i < 30; i++) {
      await server.inject({
        method: "GET",
        url: `/api/v1/evaluate/results-flag?userId=rresults-${i}`,
      });
    }

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/experiments/${exp.id}/results`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExperimentResultsResponse;
    expect(body.experimentId).toBe(exp.id);
    expect(body.status).toBe("running");
    // Total evaluations across cohorts should be >= 30 (may be higher from
    // other tests in the same process, since prom-client is a global singleton)
    const total = body.control.evaluations + body.variant.evaluations + body.holdout.evaluations;
    expect(total).toBeGreaterThanOrEqual(30);
    expect(body.durationHours).not.toBeNull();
  });
});

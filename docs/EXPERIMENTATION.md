# Experimentation Guide

> How to run A/B experiments on top of feature flags. Covers the full lifecycle —
> from writing a hypothesis to acting on the results.

This service treats experiments as a thin layer **on top of** the targeting engine.
A running experiment overrides percentage targeting for the flag it's attached to,
splits traffic into `control` / `variant` / `holdout` cohorts, and records counters
that you can aggregate into a ship/rollback decision.

---

## Mental model

```
flag          — the switch in product code
targeting     — who sees the flag enabled (percentage, env overrides)
experiment    — a time-boxed, hypothesis-driven override of targeting
cohort        — the bucket a given user lands in for a given experiment
```

One experiment is attached to exactly one flag. While the experiment is `running`,
**cohort assignment replaces percentage targeting** for any evaluation that includes
a `userId`. Anonymous evaluations (no `userId`) fall through to the flag's own
percentage config — we refuse to randomise cohorts for unknown users because that
breaks reproducibility.

### Cohort assignment

Cohorts are assigned deterministically by hashing `flagKey + userId`:

```
bucket = computeBucket(flagKey, userId)  // 0..99, uniform

if bucket <  controlPercentage                      → "control"  (flag disabled)
if bucket <  controlPercentage + variantPercentage  → "variant"  (flag enabled)
else                                                → "holdout"  (excluded)
```

Properties that follow from this:

- **Sticky** — the same `(flagKey, userId)` always lands in the same cohort. No
  server-side state needed.
- **Non-overlapping** — a user is in exactly one cohort for a given experiment.
- **Holdout is only populated when `control + variant < 100`.** A 50/50 split has
  no holdout; a 40/40 split puts 20% of users in holdout.

See `apps/api/src/experiments.ts` (`assignCohort`) and `apps/api/src/targeting.ts`
(`computeBucket`) for the exact code.

### Only the variant sees the feature

`cohortEnabled` returns `true` only for `variant`. Both `control` and `holdout`
evaluate to `enabled: false`. If the flag itself is disabled, that short-circuits
everything — a disabled flag never serves the variant, even to users in the
variant cohort. This is a safety guard: turning the flag off is always a valid
kill-switch.

---

## Writing a good hypothesis

A hypothesis is the contract for the experiment. If you can't write one, you're
not ready to start.

Structure:

> **If** we change `X`, **then** metric `M` will move by `Δ`, **because** `reason`.
> We'll measure by `primary_metric` over `duration`.

Examples:

- ✅ "If we switch to the new checkout flow, signup completion will increase by
  ≥10%, because the new flow removes two required fields. We'll measure
  `signup_completed` over 7 days."
- ❌ "Let's try the new checkout." _(No expected direction, no metric, no
  stop condition.)_
- ❌ "New pricing should be better." _(Unmeasurable. Better how?)_

Rules of thumb:

1. **One primary metric.** Secondary metrics are fine to look at, but the
   ship/rollback decision is made on the primary. Picking it after the fact is
   how you end up shipping noise.
2. **Direction and magnitude up front.** "Will move" is weaker than "will
   increase by ≥5%". The magnitude sets your minimum detectable effect and
   therefore your sample size.
3. **A reason.** The mechanism matters. If the experiment moves the metric for
   a reason you didn't predict, treat the result with suspicion — it's more
   likely a confound.
4. **A stop condition in advance.** See [When to stop](#when-to-stop).

---

## Choosing a primary metric

Good primary metrics are:

- **Close to the change.** If you're testing checkout, measure `checkout_completed`,
  not `revenue_30d`. The closer the metric, the less noise and confounds.
- **Actionable.** A metric that moves but doesn't change what you'd do is not
  worth running an experiment on.
- **Already instrumented.** If you have to ship new tracking to measure the
  experiment, ship the tracking first and verify it in production before starting.
- **Not easily gamed.** "Clicks on the variant button" will always favour the
  variant if the variant has a button and the control doesn't. Measure outcomes,
  not interactions with the change itself.

Bad primary metrics:

- Anything measured on users who never saw the feature.
- Ratios where the denominator changes with the treatment (e.g. "conversion per
  active user" when the treatment changes who counts as active).
- Metrics with a delay longer than the experiment window (don't measure 30-day
  retention in a 7-day experiment).

---

## Lifecycle

```
draft ──► running ──► concluded
  │          │             │
  │          │             └── decision recorded (ship / rollback / inconclusive)
  │          └── collecting data, flag is overridden by cohort assignment
  └── hypothesis written, metric defined, split chosen — no traffic yet
```

Transitions are enforced by `canTransitionExperiment` in `apps/api/src/experiments.ts`:

- `draft → running` ✅ via `POST /experiments/:id/start`
- `running → concluded` ✅ via `POST /experiments/:id/conclude`
- `concluded → *` ❌ terminal state
- `draft → concluded` ❌ must go through `running`
- `running → draft` ❌ no going back

Trying any other transition returns `409 EXPERIMENT_INVALID_STATE`.

### draft

The experiment exists in the DB but has no effect on evaluations. You can edit
everything — name, hypothesis, primary metric, split, notes. Once running, the
experiment is frozen (`PUT /experiments/:id` returns `409` on a non-draft).

### running

`POST /experiments/:id/start` does three things atomically from the caller's
point of view:

1. Validates no **other** experiment on the same flag is currently running
   (`409 EXPERIMENT_FLAG_CONFLICT` if one is). This is a non-atomic check —
   acceptable for the learning scope; a production system would enforce it with
   a partial unique index or advisory lock.
2. Flips the experiment to `running` and stamps `start_date`.
3. Syncs the flag: sets `enabled = true` and `rollout_percentage = variant_percentage`.
   This keeps non-experiment callers (no `userId`) consistent with the experiment's
   variant share, and makes the flag's default config meaningful again once the
   experiment ends.

Cache is invalidated on all environments for that flag.

### concluded

`POST /experiments/:id/conclude` records the decision and stamps `end_date`.
Pass `conclusion` in the body:

- `ship` — flag stays enabled at **100%** rollout. The feature is now default.
- `rollback` — flag is **disabled**. The feature is off for everyone.
- `inconclusive` — flag is **left as-is**. The operator decides manually what
  to do next (e.g. extend via a new experiment, or just leave it at the variant
  percentage while you investigate).

Notes appended via the conclude call are merged with any existing notes using
a `---` separator, so you preserve the draft/running scratch pad alongside the
final decision rationale.

All transitions are audit-logged (`entity_type = "experiment"`) with before/after
diffs and a `transition` metadata tag, so you can reconstruct the full lifecycle
from `GET /admin/audit` after the fact.

---

## When to stop

The hardest question in experimentation. "When the numbers look good" is how you
ship random noise to production.

**Pick a stop condition before you start.** The options, in rough order of
rigour:

1. **Fixed duration.** "We'll run for 7 full days." Simple, hard to game, and
   handles day-of-week effects if the window covers at least one full week.
   Best default.
2. **Fixed sample size.** "We'll run until each cohort has seen 10k evaluations."
   Better when traffic is bursty or unpredictable. Compute the sample size from
   your minimum detectable effect and baseline metric value **before starting**.
3. **Sequential testing.** Proper sequential tests (e.g. mSPRT, always-valid
   p-values) let you peek without inflating false positives. Out of scope for
   this lab — mentioned so you know the right keyword.

**Never** pick "until the result is significant". That's p-hacking — every
experiment eventually crosses any fixed threshold if you peek often enough.

Stop conditions this service doesn't enforce but you should respect:

- **Minimum sample size not reached** → extend, don't conclude. Inconclusive
  results with tiny samples are just noise.
- **Primary metric moved in the expected direction by the predicted magnitude,
  but only for the full duration** → conclude.
- **Guardrail metric (error rate, latency, crash rate) regressed** → conclude
  early with `rollback`. Guardrails are a kill-switch, not a result.
- **Cohort counts are badly imbalanced** → stop, investigate. Something broke
  in assignment or you have a confound (e.g. only logged-in users get a
  `userId`, and logged-in users behave differently).

### Reading `GET /experiments/:id/results`

The results endpoint reads straight from the Prometheus registry
(`experiment_evaluations_total` counter, filtered by `experiment_id`) and returns:

```json
{
  "experimentId": 42,
  "flagKey": "new-pricing",
  "status": "running",
  "control": { "evaluations": 5123 },
  "variant": { "evaluations": 5087 },
  "holdout": { "evaluations": 0 },
  "durationHours": 72.4
}
```

Two caveats that matter:

- **Evaluations, not unique users.** One user evaluating the flag 100 times
  contributes 100 to the counter. If you care about unique users, you need a
  product analytics tool (PostHog, etc.) keyed on `experiment.cohort` from the
  evaluate response.
- **Process-local counters.** `prom-client` counters live in memory. In a
  multi-replica deployment this would need to scrape Prometheus and query via
  PromQL instead. For this single-process lab, in-memory is enough.

The cohort balance is the first thing to check. A 50/50 split should produce
roughly equal control and variant evaluation counts. A big skew means either
the hash is behaving weirdly (unlikely) or one cohort is generating many more
evaluations per user (suspicious — investigate).

---

## Decision framework: ship / rollback / extend / inconclusive

You have four options when a running experiment's stop condition is reached.

### ship

All of:

- Primary metric moved in the hypothesised direction.
- Effect size is at least as large as what you predicted _or_ meets the business
  threshold you wrote down in the hypothesis.
- No guardrail metrics regressed beyond tolerance.
- Sample size is sufficient (see stop condition).
- You understand **why** the change worked — the mechanism matches the
  hypothesis. If you can't explain the win, you're probably looking at noise
  or a confound.

Action: `POST /experiments/:id/conclude` with `"conclusion": "ship"`.
The flag goes to 100% rollout automatically.

Write down in `notes`: the observed lift, what you'll watch for the next week,
and any caveats.

### rollback

Any of:

- Primary metric moved in the wrong direction.
- A guardrail metric regressed (error rate up, latency up, crash rate up).
- The variant has a clear UX bug discovered during the run.
- You lost confidence in the data (instrumentation broke, cohort imbalance,
  etc.).

Action: `POST /experiments/:id/conclude` with `"conclusion": "rollback"`.
The flag is disabled automatically. This is your kill-switch.

**Rollback is not failure.** A rollback with a clear learning is more valuable
than shipping a feature that quietly hurts the product.

### extend (not a conclusion state — keep running)

If the stop condition hasn't been reached, or the result is borderline but
trending, **don't conclude**. Just let it run longer. Update the experiment
`notes` with the reason you're extending and the new stop condition.

"Extending" is not a terminal state in this system — the experiment stays
`running`. If you want to change the split or hypothesis mid-flight, the right
move is to conclude (`inconclusive`) and start a new experiment, because mid-run
parameter changes invalidate the data you collected so far.

### inconclusive

The stop condition was reached but you can't commit to either ship or rollback:

- Effect is directionally right but below the predicted magnitude.
- Sample size is large but the primary metric didn't move.
- Guardrails are fine and you want to think about next steps without the
  experiment consuming traffic.

Action: `POST /experiments/:id/conclude` with `"conclusion": "inconclusive"`.
The flag is **left as-is** — still enabled at `variant_percentage`. An operator
needs to decide manually whether to leave it there, disable it, or ramp to 100%.

Record the hypothesis you're updating in `notes`. The most valuable output of
an inconclusive experiment is a sharper hypothesis for the next one.

---

## Example lifecycle

A full walk-through, using `curl` against a local API.

```bash
export API_KEY="change-me-in-production"
export BASE="http://localhost:3000/api/v1"
H="-H x-api-key:$API_KEY -H content-type:application/json"
```

### 1. Create the underlying flag

```bash
curl -X POST $BASE/flags $H -d '{
  "key": "new-pricing",
  "name": "New pricing page"
}'
```

The flag starts disabled. This is fine — we'll enable it via the experiment.

### 2. Draft the experiment

```bash
curl -X POST $BASE/experiments $H -d '{
  "flagKey": "new-pricing",
  "name": "Pricing Page A/B",
  "hypothesis": "New pricing page increases signup_completed by >=10% vs current, because the new layout surfaces the free tier earlier.",
  "primaryMetric": "signup_completed",
  "controlPercentage": 50,
  "variantPercentage": 50,
  "notes": "Stop condition: 7 full days OR 20k evaluations per cohort, whichever is later. Guardrail: checkout_error_rate < 1%."
}'
# → 201, status: "draft"
```

Draft state — no traffic is affected yet. You can still `PUT` to edit anything.

### 3. Start it

```bash
curl -X POST $BASE/experiments/1/start $H
# → 200, status: "running", startDate set
```

Now:

- `flag:new-pricing` is enabled with `rolloutPercentage = 50` (the variant share).
- The cache is invalidated across all environments.
- Any evaluation with a `userId` will go through cohort assignment.

### 4. Watch it

```bash
curl -s "$BASE/evaluate/new-pricing?userId=user-abc" | jq .
# {
#   "key": "new-pricing",
#   "enabled": true,
#   "reason": "experiment_variant",
#   "experiment": { "id": 1, "cohort": "variant" },
#   ...
# }

curl -s "$BASE/evaluate/new-pricing?userId=user-xyz" | jq .
# {
#   "enabled": false,
#   "reason": "experiment_control",
#   "experiment": { "id": 1, "cohort": "control" },
#   ...
# }

# Stickiness check: same user, twice, same cohort.
curl -s "$BASE/evaluate/new-pricing?userId=user-abc" | jq .experiment.cohort
curl -s "$BASE/evaluate/new-pricing?userId=user-abc" | jq .experiment.cohort
```

Periodically pull the results endpoint:

```bash
curl -s $BASE/experiments/1/results $H | jq .
# {
#   "experimentId": 1,
#   "flagKey": "new-pricing",
#   "status": "running",
#   "control": { "evaluations": 10234 },
#   "variant": { "evaluations": 10198 },
#   "holdout": { "evaluations": 0 },
#   "durationHours": 72.1
# }
```

Cohort balance looks healthy (50/50 split → roughly equal counts).

### 5. Conclude

Suppose seven days pass, both cohorts have ~25k evaluations, your product
analytics tool shows signup_completed is up 15.2% in the variant cohort (p<0.01,
guardrails clean). Ship it:

```bash
curl -X POST $BASE/experiments/1/conclude $H -d '{
  "conclusion": "ship",
  "notes": "15.2% lift on signup_completed over 7d, n=25k/cohort. checkout_error_rate flat at 0.3%. Monitoring: watch weekly retention cohort for next 2 weeks."
}'
# → 200, status: "concluded", conclusion: "ship", endDate set
```

Effects:

- Experiment is frozen — any further `PUT` returns `409`.
- Flag goes to `enabled = true`, `rolloutPercentage = 100` automatically.
- Cache invalidated.
- Audit log has three entries for this experiment: `created`, `updated` (start
  transition), `updated` (conclude transition).

### 6. Reconstruct the history

```bash
curl -s "$BASE/admin/audit?entityType=experiment&entityKey=1" $H | jq .
```

You'll see the full before/after chain, including the start/conclude metadata
tags. This is what makes experiments reviewable weeks or months later — the
decision and the reason are stored next to the numbers, not in someone's
head or a Slack thread.

---

## Failure modes and how this service handles them

| Situation                                                 | Response                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Create experiment for a flag that doesn't exist           | `404 FLAG_NOT_FOUND`                                         |
| `controlPercentage + variantPercentage > 100`             | `400 EXPERIMENT_INVALID_SPLIT`                               |
| Start an experiment while another is running on that flag | `409 EXPERIMENT_FLAG_CONFLICT`                               |
| Edit a running or concluded experiment                    | `409 EXPERIMENT_INVALID_STATE`                               |
| Conclude a draft experiment                               | `409 EXPERIMENT_INVALID_STATE` (must go via `running`)       |
| Evaluate with no `userId` during a running experiment     | Falls through to percentage targeting, no cohort in response |
| Flag disabled while variant cohort                        | Returns `enabled: false` — flag state is the final word      |

---

## See also

- `apps/api/src/experiments.ts` — `assignCohort`, `cohortEnabled`,
  `canTransitionExperiment`, `isValidSplit` (pure logic, unit-tested)
- `apps/api/src/routes/experiments.ts` — CRUD + lifecycle routes
- `apps/api/src/routes/evaluate.ts` — cohort assignment during evaluation
- `apps/api/src/__tests__/experiments.test.ts` — integration tests for the full
  lifecycle
- `docs/API.md` — full API reference
- `docs/ANALYTICS-DASHBOARD.md` — how experiment counters fit into the broader
  observability story

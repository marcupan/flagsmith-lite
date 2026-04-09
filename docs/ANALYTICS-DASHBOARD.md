# Analytics Dashboard Specification

> Connects system metrics (Prometheus) with product metrics (PostHog) to answer both "is the system healthy?" and "are
> users getting value from feature flags?"

---

## Data Sources

| Source     | Purpose                    | Location           |
|------------|----------------------------|--------------------|
| Prometheus | System + evaluation counts | `/metrics`         |
| PostHog    | User behavior in admin UI  | posthog.com cloud  |
| Audit Log  | Change history             | `GET /admin/audit` |

---

## Panel 1: Flag Popularity (Top 10 by evaluation rate)

**Source:** Prometheus
**Type:** Bar chart / Table

```promql
topk(10, sum by (flag_key) (rate(flag_evaluations_by_key_total[5m])))
```

**Why:** Identifies which flags are actively consumed by clients. Flags with zero evaluations are candidates for
cleanup.

---

## Panel 2: Adoption Funnel

**Source:** Audit log + Prometheus
**Type:** Funnel visualization

```
Created (audit action="created", entity_type="flag")
  → Enabled (audit action="updated", changes.enabled.to=true)
    → Evaluated (flag_evaluations_by_key_total > 0)
      → Toggled back (audit action="updated", changes.enabled.to=false)
```

**Query for step counts (Prometheus + API):**

```promql
# Evaluated flags (flags with at least 1 evaluation in the last 24h)
count(sum by (flag_key) (increase(flag_evaluations_by_key_total[24h])) > 0)
```

**Why:** Shows how many flags actually reach production usage vs being created and abandoned.

---

## Panel 3: Activity Heatmap

**Source:** Audit log (`GET /admin/audit`)
**Type:** Heatmap (hour of day × day of week)

Post-process audit events by `createdAt` timestamp to build a matrix:

| -   | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|-----|-----|-----|-----|-----|-----|-----|-----|
| 0h  | 0   | 0   | 0   | 0   | 0   | 0   | 0   |
| 9h  | 12  | 8   | 15  | 7   | 3   | 0   | 0   |
| 15h | 5   | 11  | 9   | 14  | 2   | 0   | 0   |

**Why:** Reveals patterns — "flags are always toggled at 3am during incidents" or "most changes happen Tuesday morning
after standup."

---

## Panel 4: Stale Flags (not evaluated in 7+ days)

**Source:** Prometheus
**Type:** Table with alert threshold

```promql
# Flags with no evaluations in the last 7 days
sum by (flag_key) (increase(flag_evaluations_by_key_total[7d])) == 0
```

Cross-reference with `GET /api/v1/flags` to get full flag metadata.

**Why:** Stale flags are technical debt. If a flag hasn't been evaluated in a week, it's either:

- Dead code (remove flag + code path)
- Fully rolled out (make it permanent, remove the check)
- Misconfigured (investigate)

---

## Panel 5: Marketing Funnel

**Source:** PostHog (frontend events) + GA4 (optional)
**Type:** Funnel visualization

```
Awareness (page_viewed event count)
  → Signup (API key created — future event)
    → Activation (flag_created event — first flag)
      → Engagement (10+ flag_evaluations_by_key_total per flag)
        → Retention (dashboard_loaded event 7+ days after first flag_created)
```

**PostHog query (pseudo):**

```
funnel([
  { event: "page_viewed" },
  { event: "flag_created" },
  { event: "flag_toggled" },
  { event: "dashboard_loaded", filters: { days_since_first_flag: ">= 7" } }
])
```

**Why:** Conversion rate between steps shows where users drop off. Low activation means onboarding friction. Low
retention means the product isn't sticky.

---

## Panel 6: Campaign Attribution

**Source:** Prometheus + Audit log
**Type:** Table per campaign/flag

For each feature flag used as a campaign:

| Metric                    | Query                                                                          |
|---------------------------|--------------------------------------------------------------------------------|
| Users who saw the feature | `sum(flag_evaluations_by_key_total{flag_key="campaign-x", result="enabled"})`  |
| Users in control group    | `sum(flag_evaluations_by_key_total{flag_key="campaign-x", result="disabled"})` |
| Conversion (target event) | PostHog: `flag_toggled` events with `key="campaign-x"`                         |
| Lift vs control           | `(conversion_enabled - conversion_disabled) / conversion_disabled * 100`       |

**Why:** Connects feature flag rollout directly to business outcomes. Answers "did enabling this flag for 50% of users
increase engagement?"

---

## Environment Variables

| Variable            | Required | Default                   | Purpose                                      |
|---------------------|----------|---------------------------|----------------------------------------------|
| `VITE_POSTHOG_KEY`  | No       | —                         | PostHog project API key                      |
| `VITE_POSTHOG_HOST` | No       | `https://app.posthog.com` | PostHog API host (self-hosted)               |
| `VITE_GA4_ID`       | No       | —                         | Google Analytics 4 measurement ID (optional) |

When `VITE_POSTHOG_KEY` is not set, the frontend runs normally without any tracking — all `posthog.capture()` calls are
silent no-ops.

---

## Implementation Status

- [x] `flag_evaluations_by_key_total` Prometheus counter (labels: `flag_key`, `result`, `source`)
- [x] PostHog SDK integrated in `apps/web/` (`posthog-js`)
- [x] Frontend events: `page_viewed`, `dashboard_loaded`, `flag_created`, `flag_toggled`, `flag_deleted`
- [x] Grafana panel for Top 10 flag evaluation rate
- [ ] PostHog funnel dashboards (requires PostHog account setup)
- [ ] GA4 integration (optional — documented but not implemented)
- [ ] Stale flag alerting rule

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

export const flags = pgTable("flags", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  /** Percentage of users who see this flag when enabled (0-100). Default 100 = all users. */
  rolloutPercentage: integer("rollout_percentage").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flag Overrides (per-environment) ────────────────────────────────────

export const flagOverrides = pgTable(
  "flag_overrides",
  {
    id: serial("id").primaryKey(),
    flagId: integer("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    /** Environment key: dev | staging | production */
    environment: text("environment").notNull(),
    enabled: boolean("enabled").notNull(),
    rolloutPercentage: integer("rollout_percentage").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("flag_overrides_flag_env_uq").on(table.flagId, table.environment),
    index("flag_overrides_lookup_idx").on(table.flagId, table.environment),
  ],
);

// ── Webhook Subscriptions ────────────────────────────────────────────────

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: serial("id").primaryKey(),
  /** Consumer endpoint that receives POST notifications */
  url: text("url").notNull(),
  // TODO(security): Secret is stored plaintext. Encrypt at rest with AES-256-GCM
  // using a server-managed key (env var or KMS). Decrypt in worker before HMAC signing.
  // Risk: DB read access (backup leak, SQL injection) exposes all secrets.
  secret: text("secret").notNull(),
  /** JSON-encoded array of event types, e.g. ["flag.toggled","flag.created"] */
  events: text("events").array().notNull(),
  /** Soft toggle — inactive subscriptions skip delivery */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Webhook Deliveries ───────────────────────────────────────────────────

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
  flagKey: text("flag_key").notNull(),
  eventType: text("event_type").notNull(),
  /** Delivery state machine: pending → sending → delivered|retrying|failed → dead */
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** End-to-end trace ID linking API request → enqueue → worker → delivery */
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Delivery Transitions (audit log) ─────────────────────────────────────

export const deliveryTransitions = pgTable(
  "delivery_transitions",
  {
    id: serial("id").primaryKey(),
    deliveryId: integer("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    /** null for initial creation (→ pending) */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_delivery_transitions_delivery_id").on(table.deliveryId)],
);

// ── Experiments ─────────────────────────────────────────────────────────

/**
 * A/B experiment bound to a feature flag.
 *
 * Lifecycle: draft → running → concluded.
 *   - draft:     only editable state; no cohort assignment yet
 *   - running:   evaluate returns cohort (control|variant|holdout); immutable
 *   - concluded: decision recorded; no further writes
 *
 * Invariant: at most one experiment per flag may be in "running" state.
 * Enforced in service layer (`experiments.ts`), not by a partial unique
 * index, because Postgres partial indexes over text values work but add
 * migration overhead disproportionate to the learning value here.
 */
export const experiments = pgTable(
  "experiments",
  {
    id: serial("id").primaryKey(),
    /** References flags.key (business key, not surrogate id) */
    flagKey: text("flag_key")
      .notNull()
      .references(() => flags.key, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hypothesis: text("hypothesis").notNull(),
    /** State machine: draft → running → concluded */
    status: text("status").notNull().default("draft"),
    /** Percentage of users in the control cohort (flag disabled) */
    controlPercentage: integer("control_percentage").notNull().default(50),
    /** Percentage of users in the variant cohort (flag enabled) */
    variantPercentage: integer("variant_percentage").notNull().default(50),
    /** Name of the primary success metric, e.g. "checkout_completed" */
    primaryMetric: text("primary_metric").notNull(),
    /** When the experiment transitioned to running */
    startDate: timestamp("start_date", { withTimezone: true }),
    /** When the experiment transitioned to concluded */
    endDate: timestamp("end_date", { withTimezone: true }),
    /** Final decision: ship | rollback | inconclusive */
    conclusion: text("conclusion"),
    /** Free-form notes captured throughout the experiment lifecycle */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_experiments_flag_key").on(table.flagKey),
    index("idx_experiments_status").on(table.status),
  ],
);

// ── Audit Events (append-only) ──────────────────────────────────────────

export const auditEvents = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    /** What kind of entity changed: flag, override, subscription */
    entityType: text("entity_type").notNull(),
    /** Business key of the entity, e.g. flag key or subscription id */
    entityKey: text("entity_key").notNull(),
    /** What happened: created, updated, deleted */
    action: text("action").notNull(),
    /** SHA-256 prefix (8 chars) of the API key that performed the action */
    actor: text("actor").notNull(),
    /** Only the changed fields: { field: { from, to } } */
    changes: jsonb("changes").notNull().default({}),
    /** Extra context: environment, IP, correlation ID, etc. */
    metadata: jsonb("metadata").notNull().default({}),
    /** Immutable — no updatedAt column by design (append-only) */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_entity").on(table.entityType, table.entityKey),
    index("idx_audit_timestamp").on(table.createdAt),
  ],
);

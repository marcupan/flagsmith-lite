import { boolean, integer, pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const flags = pgTable("flags", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Webhook Subscriptions ────────────────────────────────────────────────

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: serial("id").primaryKey(),
  /** Consumer endpoint that receives POST notifications */
  url: text("url").notNull(),
  /** HMAC-SHA256 secret for signing payloads (stored hashed, worker needs plaintext via encryption) */
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

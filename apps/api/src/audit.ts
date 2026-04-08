/**
 * Audit service — append-only event log for all mutating operations.
 *
 * Design principles:
 *   1. Append-only: no UPDATE/DELETE on audit_events
 *   2. Diff-based: store only changed fields, not full snapshots
 *   3. Actor = hashed API key prefix (never log the full key)
 *   4. Fire-and-forget: audit write failure is logged but never blocks the response
 */
import { createHash } from "node:crypto";

import type { AuditAction, AuditEntityType, FieldChange } from "@project/shared";

import { auditEvents } from "./schema.js";
import type { Db } from "./db.js";
import { auditEventsTotal } from "./metrics.js";

export interface AuditEntry {
  entityType: AuditEntityType;
  entityKey: string;
  action: AuditAction;
  actor: string;
  changes: Record<string, FieldChange>;
  metadata?: Record<string, unknown>;
}

/**
 * Hash the API key and return the first 8 hex characters.
 * This is enough for identification without being reversible.
 */
export function hashActor(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").substring(0, 8);
}

/**
 * Compute the diff between two objects, returning only changed fields.
 *
 * Compares values using JSON.stringify for deep equality.
 * Only includes fields that exist in `after` (newly added or changed).
 * For deleted entities, pass the full object as `before` and {} as `after`.
 *
 * @example
 *   diffChanges(
 *     { enabled: false, name: "Old" },
 *     { enabled: true, name: "Old" }
 *   )
 *   // → { enabled: { from: false, to: true } }
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, FieldChange> {
  const diff: Record<string, FieldChange> = {};

  // Fields that changed or were added
  for (const key of Object.keys(after)) {
    const fromVal = before[key];
    const toVal = after[key];

    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      diff[key] = { from: fromVal ?? null, to: toVal };
    }
  }

  // Fields that were removed (exist in before but not in after)
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      diff[key] = { from: before[key], to: null };
    }
  }

  return diff;
}

/**
 * Record an audit event. Fire-and-forget — failures are logged, not thrown.
 *
 * @param db - Drizzle database instance
 * @param entry - Audit entry to record
 * @param log - Logger for error reporting (optional, defaults to console)
 */
export async function recordAudit(
  db: Db,
  entry: AuditEntry,
  log?: { error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      entityType: entry.entityType,
      entityKey: entry.entityKey,
      action: entry.action,
      actor: entry.actor,
      changes: entry.changes,
      metadata: entry.metadata ?? {},
    });

    auditEventsTotal.inc({
      entity_type: entry.entityType,
      action: entry.action,
    });
  } catch (err) {
    // Audit failure must never block the main operation
    const logger = log ?? console;
    logger.error({ err, entry }, "Failed to record audit event");
  }
}

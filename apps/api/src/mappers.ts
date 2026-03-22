/**
 * Pure data-mapping functions — no I/O, no side effects.
 * Extracted for unit testability and reuse across routes.
 */
import { FlagKey, Timestamp, type Flag } from "@project/shared";
import type { flags } from "./schema.js";

/** DB row → API response. Brands key and converts Date → Timestamp. */
export function toFlagResponse(row: typeof flags.$inferSelect): Flag {
  return {
    id: row.id,
    key: FlagKey(row.key),
    name: row.name,
    enabled: row.enabled,
    description: row.description,
    createdAt: Timestamp(row.createdAt),
    updatedAt: Timestamp(row.updatedAt),
  };
}

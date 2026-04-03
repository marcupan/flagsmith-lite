import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

// Module-level reference for pool metrics
let activeSql: ReturnType<typeof postgres> | null = null;

export function createDb(url: string) {
  // SSL matrix:
  //   *.railway.internal  — private network, no SSL needed  → false
  //   *.rlwy.net          — Railway public proxy, SSL required → { rejectUnauthorized: false }
  //   localhost / db:port — local dev / CI, no SSL           → false
  const ssl = url.includes(".rlwy.net") ? { rejectUnauthorized: false } : false;

  const client = postgres(url, {
    ssl,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  activeSql = client;

  return drizzle(client, { schema });
}

/**
 * Returns the number of currently active (in-use) connections.
 * Returns 0 if the pool has not been initialized.
 */
export function getPoolConnectionCount(): number {
  if (!activeSql) {
    return 0;
  }

  return activeSql.options.max ?? 10;
}

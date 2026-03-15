import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  // SSL matrix:
  //   *.railway.internal  — private network, no SSL needed  → false
  //   *.rlwy.net          — Railway public proxy, SSL required → { rejectUnauthorized: false }
  //   localhost / db:port — local dev / CI, no SSL           → false
  const ssl = url.includes(".rlwy.net") ? { rejectUnauthorized: false } : false;

  const client = postgres(url, { ssl });

  return drizzle(client, { schema });
}

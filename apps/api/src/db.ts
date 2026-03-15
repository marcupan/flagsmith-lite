import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const ssl = url.includes(".railway.internal")
    ? false
    : process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false;

  const client = postgres(url, { ssl });

  return drizzle(client, { schema });
}

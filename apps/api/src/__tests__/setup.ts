import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../drizzle");

// Run migrations once before all test files
const client = postgres(process.env.DATABASE_URL!, { max: 1 });
await migrate(drizzle(client), { migrationsFolder });
await client.end();

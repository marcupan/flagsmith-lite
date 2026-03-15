import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Required env var "DATABASE_URL" is not set');

// SSL matrix:
//   *.railway.internal  — private network, no SSL needed  → false
//   *.rlwy.net          — Railway public proxy, SSL required → { rejectUnauthorized: false }
//   localhost / db:port — local dev / CI, no SSL           → false
const ssl = url.includes(".rlwy.net") ? { rejectUnauthorized: false } : false;

const client = postgres(url, { max: 1, ssl });
const db = drizzle(client);

await migrate(db, { migrationsFolder: join(__dirname, "drizzle") });
console.log("Migrations complete");

await client.end();

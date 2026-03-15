import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Required env var "DATABASE_URL" is not set');

// Railway internal URLs (postgres.railway.internal) don't use SSL;
// external/public URLs require SSL in production.
const ssl = url.includes(".railway.internal")
  ? false
  : process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false;

const client = postgres(url, { max: 1, ssl });
const db = drizzle(client);

await migrate(db, { migrationsFolder: join(__dirname, "drizzle") });
console.log("Migrations complete");

await client.end();

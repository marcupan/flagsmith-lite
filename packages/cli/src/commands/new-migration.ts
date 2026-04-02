import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "apps/api/drizzle";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function newMigration(name: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const slug = slugify(name);
  const filename = `${timestamp}_${slug}.sql`;
  const filepath = join(MIGRATIONS_DIR, filename);

  const content = `-- Migration: ${name}\n-- Created: ${new Date().toISOString()}\n\n-- Write your SQL here\n`;

  writeFileSync(filepath, content, "utf-8");
  console.log(`\x1b[32m[+]\x1b[0m Created ${filepath}`);
  console.log(`    Name: ${name}`);
}

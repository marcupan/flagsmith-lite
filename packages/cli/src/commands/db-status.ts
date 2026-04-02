import { readdirSync } from "node:fs";

const MIGRATIONS_DIR = "apps/api/drizzle";
const META_DIR = "apps/api/drizzle/meta";

export async function dbStatus(): Promise<void> {
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const DIM = "\x1b[2m";
  const NC = "\x1b[0m";

  try {
    const sqlFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    console.log(`\n  ${GREEN}Migration Status${NC}\n`);
    console.log(`  ${"File".padEnd(50)} Status`);
    console.log(`  ${"─".repeat(50)} ${"─".repeat(15)}`);

    // Check if meta/_journal.json exists for tracking applied migrations
    let appliedMigrations: string[] = [];

    try {
      const journalPath = `${META_DIR}/_journal.json`;
      const journalText = await import("node:fs").then((fs) =>
        fs.readFileSync(journalPath, "utf-8"),
      );
      const journal = JSON.parse(journalText) as { entries: Array<{ tag: string }> };

      appliedMigrations = journal.entries.map((e) => e.tag);
    } catch {
      // No journal found — can't determine applied status
    }

    let applied = 0;
    let pending = 0;

    for (const file of sqlFiles) {
      const tag = file.replace(".sql", "");
      const isApplied = appliedMigrations.includes(tag);
      const status = isApplied ? `${GREEN}applied${NC}` : `${YELLOW}pending${NC}`;

      if (isApplied) {
        applied++;
      } else {
        pending++;
      }

      console.log(`  ${file.padEnd(50)} ${status}`);
    }

    console.log(
      `\n  ${DIM}Total: ${sqlFiles.length} | Applied: ${applied} | Pending: ${pending}${NC}\n`,
    );

    if (pending > 0) {
      console.log(`  Run migrations: pnpm --filter @project/api migrate:local\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    console.error(`Cannot read migrations directory: ${msg}`);
    console.error(`Expected at: ${MIGRATIONS_DIR}/`);

    process.exit(1);
  }
}

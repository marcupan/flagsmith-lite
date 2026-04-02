#!/usr/bin/env tsx
import { Command } from "commander";
import { newAdr } from "./commands/new-adr.js";
import { newMigration } from "./commands/new-migration.js";
import { health } from "./commands/health.js";
import { metrics } from "./commands/metrics.js";
import { dbStatus } from "./commands/db-status.js";

const program = new Command()
  .name("flagsmith-cli")
  .description("CLI tools for flagsmith-lite monorepo")
  .version("1.0.0");

program
  .command("new:adr <title>")
  .description("Create a new ADR from template (e.g. pnpm cli new:adr 'Queue technology')")
  .action(newAdr);

program
  .command("new:migration <name>")
  .description("Create a timestamped migration file (e.g. pnpm cli new:migration 'add_attempts')")
  .action(newMigration);

program
  .command("health")
  .description("Check health of all services: API, Postgres, Redis, Prometheus, Grafana")
  .action(health);

program
  .command("metrics")
  .description("Fetch and display key metrics from the API /metrics endpoint")
  .action(metrics);

program
  .command("db:status")
  .description("Show migration status (applied vs pending)")
  .action(dbStatus);

program.parse();

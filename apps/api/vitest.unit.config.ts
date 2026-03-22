import { defineConfig } from "vitest/config";

/**
 * Config for unit tests only — no DB, no Redis, no setup files.
 * Run via: pnpm --filter @project/api test:unit
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/unit/**/*.test.ts"],
    // No setupFiles — unit tests must not touch external services
  },
});

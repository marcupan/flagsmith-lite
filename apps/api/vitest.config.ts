import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["src/__tests__/setup.ts"],
    // Unit tests have their own config (vitest.unit.config.ts) — no DB setup needed.
    // dist/ contains compiled .js from tsc — must be excluded to avoid double-runs.
    exclude: ["src/__tests__/unit/**", "dist/**", "**/node_modules/**"],
    env: {
      NODE_ENV: "test",
      // Prefer DATABASE_URL from the shell (CI injects port 5432); fall back to
      // the local-dev Docker Compose mapping which exposes Postgres on 5433.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://flagr:password@localhost:5433/flagr",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      API_KEY: process.env.API_KEY ?? "test-api-key",
      CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});

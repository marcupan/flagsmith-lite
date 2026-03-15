import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["src/__tests__/setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://flagr:password@localhost:5433/flagr",
      REDIS_URL: "redis://localhost:6379",
      API_KEY: "test-api-key",
      CORS_ORIGIN: "http://localhost:3000",
    },
  },
});

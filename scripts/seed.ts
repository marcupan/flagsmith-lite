/**
 * Seed script — populates the database with development data.
 *
 * Usage: pnpm tsx scripts/seed.ts
 * Requires: DATABASE_URL env var or apps/api/.env file
 *
 * Idempotent: safe to run multiple times. Uses INSERT ... ON CONFLICT DO NOTHING
 * so existing rows are not duplicated.
 */

import "dotenv/config";

const BASE = `http://localhost:${process.env.PORT ?? 3000}`;
const API_KEY = process.env.API_KEY ?? "change-me-in-production";

const headers = {
  "Content-Type": "application/json",
  "X-Api-Key": API_KEY,
};

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return { status: res.status, data: await res.json() };
}

async function seed() {
  console.log("🌱 Seeding development data...\n");

  // ── Flags ───────────────────────────────────────────────────────────
  const flagDefs = [
    {
      key: "dark-mode",
      name: "Dark Mode",
      enabled: false,
      description: "Toggle dark theme for all users",
    },
    {
      key: "new-dashboard",
      name: "New Dashboard",
      enabled: true,
      description: "Redesigned analytics dashboard",
    },
    {
      key: "beta-search",
      name: "Beta Search",
      enabled: false,
      description: "Elasticsearch-powered search",
    },
    {
      key: "maintenance-banner",
      name: "Maintenance Banner",
      enabled: false,
      description: "Show scheduled maintenance notice",
    },
    {
      key: "feature-webhooks",
      name: "Feature Webhooks",
      enabled: true,
      description: "Webhook delivery subsystem",
    },
  ];

  for (const flag of flagDefs) {
    const { status } = await post("/api/v1/flags", flag);
    const icon = status === 201 ? "✅" : status === 409 ? "⏭️ " : "❌";
    const label = status === 201 ? "created" : status === 409 ? "exists" : `error ${status}`;

    console.log(`  ${icon} Flag "${flag.key}" — ${label}`);
  }

  // ── Webhook Subscriptions ─────────────────────────────────────────
  const webhookDefs = [
    {
      url: "https://httpbin.org/post",
      events: ["flag.toggled"],
      secret: "httpbin-dev-secret-1234567890",
    },
    {
      url: "https://webhook.site/test",
      events: ["flag.toggled", "flag.created", "flag.deleted"],
      secret: "webhook-site-secret-1234567890",
    },
  ];

  console.log("");
  for (const webhook of webhookDefs) {
    const { status } = await post("/api/v1/webhooks", webhook);
    const icon = status === 201 ? "✅" : "❌";
    const label = status === 201 ? "created" : `error ${status}`;

    console.log(`  ${icon} Webhook "${webhook.url}" — ${label}`);
  }

  console.log("\n🌱 Seed complete!");
  console.log("\n  Try it:");
  console.log(`    curl -s ${BASE}/api/v1/flags -H "X-Api-Key: ${API_KEY}" | jq .`);
  console.log(`    curl -s ${BASE}/api/v1/evaluate/dark-mode | jq .`);
  console.log(
    `    curl -s -X PUT ${BASE}/api/v1/flags/dark-mode -H "Content-Type: application/json" -H "X-Api-Key: ${API_KEY}" -d '{"enabled":true}' | jq .`,
  );
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});

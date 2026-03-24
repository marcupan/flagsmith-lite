/**
 * Failure simulation scenarios for webhook delivery.
 *
 * Usage:
 *   pnpm tsx scripts/simulate.ts <scenario>
 *
 * Requires:
 *   - API running on localhost:3000
 *   - Valid API_KEY in .env (or pass via env)
 *
 * Scenarios:
 *   duplicate — rapid flag toggles, verify correct delivery count
 *   flaky     — mock consumer that fails 70% of requests
 *   poison    — unreachable consumer URL, verify the dead after max retries
 *   burst     — 50 flag toggles in 1 second
 */

import { createServer, type Server } from "node:http";

const BASE = process.env.BASE_URL ?? "http://localhost:3000/api/v1";
const API_KEY = process.env.API_KEY ?? "change-me-in-production";

const headers = {
  "Content-Type": "application/json",
  "X-Api-Key": API_KEY,
};

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json().catch(() => null);
}

async function ensureFlag(key: string): Promise<void> {
  await api("POST", "/flags", { key, name: key });
}

async function toggleFlag(key: string, enabled: boolean): Promise<void> {
  await api("PUT", `/flags/${key}`, { enabled });
}

async function createSubscription(
  url: string,
  events: string[],
  secret = "simulation-secret-1234",
): Promise<number> {
  const res = (await api("POST", "/webhooks", { url, events, secret })) as { id: number };
  return res.id;
}

async function getDeliveries(subscriptionId: number): Promise<unknown[]> {
  return (await api("GET", `/webhooks/${subscriptionId}/deliveries`)) as unknown[];
}

async function cleanup(subscriptionIds: number[], flagKeys: string[]): Promise<void> {
  for (const id of subscriptionIds) {
    await api("DELETE", `/webhooks/${id}`).catch(() => {});
  }
  for (const key of flagKeys) {
    await api("DELETE", `/flags/${key}`).catch(() => {});
  }
}

function startMockConsumer(opts: { failureRate: number; port: number }): {
  server: Server;
  received: number;
  failed: number;
} {
  const state = { server: null as unknown as Server, received: 0, failed: 0 };

  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      state.received++;
      if (Math.random() < opts.failureRate) {
        state.failed++;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Simulated failure" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  state.server.listen(opts.port);
  return state;
}

// ── Scenarios ─────────────────────────────────────────────────────────────

async function simulateDuplicate(): Promise<void> {
  console.log("\n=== Scenario: Duplicate Delivery ===\n");
  console.log("Toggle same flag 3 times rapidly. Each toggle should create exactly 1 delivery.\n");

  const flagKey = "sim-dup-flag";
  await ensureFlag(flagKey);
  const subId = await createSubscription("https://example.com/dup-hook", ["flag.toggled"]);

  await toggleFlag(flagKey, true);
  await sleep(100);
  await toggleFlag(flagKey, false);
  await sleep(100);
  await toggleFlag(flagKey, true);

  await sleep(2000);

  const deliveries = await getDeliveries(subId);
  console.log(`Total deliveries: ${deliveries.length}`);
  console.log(`Expected: 3 (one per toggle)`);
  console.log(
    deliveries.length === 3 ? "PASS" : "FAIL — check for dedup issues or missing enqueue",
  );

  await cleanup([subId], [flagKey]);
}

async function simulateFlaky(): Promise<void> {
  console.log("\n=== Scenario: Flaky Consumer ===\n");
  console.log("Mock consumer fails 70% of requests. Toggle 5 flags.\n");

  const PORT = 19876;
  const mock = startMockConsumer({ failureRate: 0.7, port: PORT });

  const flagKeys: string[] = [];
  for (let i = 0; i < 5; i++) {
    flagKeys.push(`sim-flaky-${i}`);
    await ensureFlag(`sim-flaky-${i}`);
  }

  const subId = await createSubscription(`http://localhost:${PORT}/webhook`, ["flag.toggled"]);

  for (const key of flagKeys) {
    await toggleFlag(key, true);
  }

  console.log("Waiting 10s for retries...");
  await sleep(10_000);

  const deliveries = (await getDeliveries(subId)) as { state: string }[];
  const stats = deliveries.reduce(
    (acc, d) => {
      acc[d.state] = (acc[d.state] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log(`\nMock consumer: ${mock.received} requests received, ${mock.failed} returned 500`);
  console.log("Delivery states:");
  console.table(stats);

  mock.server.close();
  await cleanup([subId], flagKeys);
}

async function simulatePoison(): Promise<void> {
  console.log("\n=== Scenario: Poison Delivery ===\n");
  console.log("Subscription URL is unreachable. Should reach dead after max retries.\n");

  const flagKey = "sim-poison-flag";
  await ensureFlag(flagKey);

  // Port 19877 has nothing listening — every attempt will fail with ECONNREFUSED
  const subId = await createSubscription("http://localhost:19877/blackhole", ["flag.toggled"]);

  await toggleFlag(flagKey, true);

  console.log("Waiting 15s for retries to exhaust...");
  await sleep(15_000);

  const deliveries = (await getDeliveries(subId)) as { state: string; attempts: number }[];
  for (const d of deliveries) {
    console.log(`  Delivery state: ${d.state}, attempts: ${d.attempts}`);
  }

  const allDead = deliveries.every((d) => d.state === "dead");
  console.log(allDead ? "PASS — all deliveries reached dead" : "FAIL — some not yet dead");

  await cleanup([subId], [flagKey]);
}

async function simulateBurst(): Promise<void> {
  console.log("\n=== Scenario: Burst ===\n");
  console.log("Toggle 50 flags in ~1 second. Monitor delivery processing.\n");

  const PORT = 19878;
  const mock = startMockConsumer({ failureRate: 0.0, port: PORT });

  const flagKeys: string[] = [];
  for (let i = 0; i < 50; i++) {
    flagKeys.push(`sim-burst-${i}`);
    await ensureFlag(`sim-burst-${i}`);
  }

  const subId = await createSubscription(`http://localhost:${PORT}/webhook`, ["flag.toggled"]);

  console.log("Firing 50 toggles...");
  const start = Date.now();
  const togglePromises = flagKeys.map((key) => toggleFlag(key, true));
  await Promise.all(togglePromises);
  console.log(`All 50 toggles fired in ${Date.now() - start}ms`);

  console.log("Waiting 15s for all deliveries to process...");
  await sleep(15_000);

  const deliveries = (await getDeliveries(subId)) as { state: string }[];
  const stats = deliveries.reduce(
    (acc, d) => {
      acc[d.state] = (acc[d.state] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log(`Total deliveries: ${deliveries.length}`);
  console.log(`Mock consumer received: ${mock.received} requests`);
  console.log("Delivery states:");
  console.table(stats);
  console.log(deliveries.length === 50 ? "PASS — all 50 enqueued" : `FAIL — expected 50`);

  mock.server.close();
  await cleanup([subId], flagKeys);
}

// ── Main ──────────────────────────────────────────────────────────────────

const scenarios: Record<string, () => Promise<void>> = {
  duplicate: simulateDuplicate,
  flaky: simulateFlaky,
  poison: simulatePoison,
  burst: simulateBurst,
};

const scenario = process.argv[2];

if (!scenario || !(scenario in scenarios)) {
  console.log("Usage: pnpm tsx scripts/simulate.ts <scenario>");
  console.log("Available scenarios:", Object.keys(scenarios).join(", "));
  process.exit(1);
}

scenarios[scenario]()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Simulation failed:", err);
    process.exit(1);
  });

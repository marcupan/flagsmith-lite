interface ServiceCheck {
  name: string;
  url: string;
  check: () => Promise<{ ok: boolean; ms: number; detail: string }>;
}

async function httpCheck(url: string): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = performance.now();

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const ms = Math.round(performance.now() - start);

    return { ok: res.ok, ms, detail: `${res.status} ${res.statusText}` };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : "unknown error";

    return { ok: false, ms, detail: message };
  }
}

async function tcpCheck(
  host: string,
  port: number,
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = performance.now();

  try {
    const { createConnection } = await import("node:net");

    return await new Promise((resolve) => {
      const socket = createConnection({ host, port, timeout: 5000 }, () => {
        const ms = Math.round(performance.now() - start);
        socket.destroy();
        resolve({ ok: true, ms, detail: "ready" });
      });
      socket.on("error", (err) => {
        const ms = Math.round(performance.now() - start);
        socket.destroy();
        resolve({ ok: false, ms, detail: err.message });
      });
      socket.on("timeout", () => {
        const ms = Math.round(performance.now() - start);
        socket.destroy();
        resolve({ ok: false, ms, detail: "timeout" });
      });
    });
  } catch (err) {
    const ms = Math.round(performance.now() - start);

    return { ok: false, ms, detail: err instanceof Error ? err.message : "unknown" };
  }
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export async function health(): Promise<void> {
  const services: ServiceCheck[] = [
    {
      name: "API",
      url: "http://localhost:3000/health",
      check: () => httpCheck("http://localhost:3000/health"),
    },
    {
      name: "Postgres",
      url: "localhost:5433",
      check: () => tcpCheck("localhost", 5433),
    },
    {
      name: "Redis",
      url: "localhost:6379",
      check: () => tcpCheck("localhost", 6379),
    },
    {
      name: "Prometheus",
      url: "http://localhost:9090/-/healthy",
      check: () => httpCheck("http://localhost:9090/-/healthy"),
    },
    {
      name: "Grafana",
      url: "http://localhost:3001/api/health",
      check: () => httpCheck("http://localhost:3001/api/health"),
    },
  ];

  console.log("\n  Service Health Check\n");
  console.log(
    `  ${"Service".padEnd(14)} ${"Endpoint".padEnd(35)} ${"Status".padEnd(8)} ${"Time".padEnd(8)} Detail`,
  );
  console.log(
    `  ${"─".repeat(14)} ${"─".repeat(35)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(20)}`,
  );

  const results = await Promise.all(
    services.map(async (svc) => {
      const result = await svc.check();
      return { ...svc, ...result };
    }),
  );

  for (const r of results) {
    const icon = r.ok ? `${GREEN}OK${NC}` : `${RED}FAIL${NC}`;
    const ms = `${DIM}${r.ms}ms${NC}`;
    console.log(
      `  ${r.name.padEnd(14)} ${r.url.padEnd(35)} ${icon.padEnd(18)} ${ms.padEnd(18)} ${r.detail}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n  ${RED}${failed.length} service(s) unavailable${NC}\n`);
  } else {
    console.log(`\n  ${GREEN}All services healthy${NC}\n`);
  }
}

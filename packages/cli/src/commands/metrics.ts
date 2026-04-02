const METRICS_URL = "http://localhost:3000/metrics";

interface ParsedMetric {
  name: string;
  value: string;
  labels: string;
}

function parsePrometheusText(text: string): ParsedMetric[] {
  const results: ParsedMetric[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }

    const match = line.match(/^(\w+)(\{[^}]*})?\s+(.+)$/);

    if (match) {
      results.push({
        name: match[1] ?? "",
        labels: match[2] ?? "",
        value: match[3] ?? "",
      });
    }
  }

  return results;
}

const KEY_METRICS = [
  "http_request_total",
  "http_request_duration_seconds_count",
  "http_request_duration_seconds_sum",
  "flag_evaluations_total",
  "webhook_deliveries_total",
  "webhook_delivery_duration_seconds_count",
  "webhook_queue_depth",
  "circuit_breaker_state",
];

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export async function metrics(): Promise<void> {
  try {
    const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`Failed to fetch metrics: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const text = await res.text();
    const parsed = parsePrometheusText(text);
    const filtered = parsed.filter((m) => KEY_METRICS.some((k) => m.name.startsWith(k)));

    console.log(`\n  ${GREEN}Key Metrics${NC} ${DIM}(from ${METRICS_URL})${NC}\n`);
    console.log(`  ${"Metric".padEnd(45)} ${"Labels".padEnd(35)} Value`);
    console.log(`  ${"─".repeat(45)} ${"─".repeat(35)} ${"─".repeat(15)}`);

    for (const m of filtered) {
      console.log(`  ${m.name.padEnd(45)} ${DIM}${m.labels.padEnd(35)}${NC} ${m.value}`);
    }

    console.log(
      `\n  ${DIM}Total lines: ${parsed.length} | Showing: ${filtered.length} key metrics${NC}\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    console.error(`Cannot reach metrics endpoint: ${msg}`);
    console.error("Is the API running? Start with: pnpm --filter @project/api dev");

    process.exit(1);
  }
}

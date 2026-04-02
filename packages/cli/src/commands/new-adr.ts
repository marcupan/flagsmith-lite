import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ADR_DIR = "docs/adr";

const TEMPLATE = `# ADR-{NUMBER}: {TITLE}

## Status

Proposed

## Context

<!-- What is the issue that we're seeing that is motivating this decision? -->

## Decision

<!-- What is the change that we're proposing and/or doing? -->

## Consequences

<!-- What becomes easier or more difficult to do because of this change? -->
`;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function newAdr(title: string): Promise<void> {
  const existing = readdirSync(ADR_DIR).filter((f) => f.match(/^\d{3}-.*\.md$/));
  const nextNumber = existing.length + 1;
  const paddedNumber = String(nextNumber).padStart(3, "0");
  const slug = slugify(title);
  const filename = `${paddedNumber}-${slug}.md`;
  const filepath = join(ADR_DIR, filename);

  const content = TEMPLATE.replace("{NUMBER}", paddedNumber).replace("{TITLE}", title);

  writeFileSync(filepath, content, "utf-8");
  console.log(`\x1b[32m[+]\x1b[0m Created ${filepath}`);
  console.log(`    Title: ADR-${paddedNumber}: ${title}`);
}

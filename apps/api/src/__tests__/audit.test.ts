import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../index.js";
import { createDb } from "../db.js";
import { flags, flagOverrides, auditEvents } from "../schema.js";
import type { AuditEvent } from "@project/shared";

const db = createDb(process.env.DATABASE_URL!);
let server: Awaited<ReturnType<typeof buildServer>>;
const authHeader = { "x-api-key": "test-api-key" };

beforeAll(async () => {
  server = await buildServer({ db, cache: null, apiKey: "test-api-key", rateLimit: false });
});

afterAll(() => server.close());

beforeEach(async () => {
  await db.delete(flagOverrides);
  await db.delete(flags);
  await db.delete(auditEvents);
});

/**
 * Helper: wait briefly for fire-and-forget audit writes to flush.
 * recordAudit is async but not awaited by routes (fire-and-forget),
 * so we need a tiny delay before querying the audit table.
 */
async function waitForAudit(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Helper: query audit events via the admin endpoint */
async function queryAudit(params: Record<string, string> = {}): Promise<AuditEvent[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await server.inject({
    method: "GET",
    url: `/api/v1/admin/audit${qs ? `?${qs}` : ""}`,
    headers: authHeader,
  });

  expect(res.statusCode).toBe(200);
  return res.json() as AuditEvent[];
}

describe("flag audit trail", () => {
  it("records created → updated → deleted events for a flag lifecycle", async () => {
    // 1. Create flag
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "audit-test", name: "Audit Test" },
    });

    await waitForAudit();

    // 2. Update flag (toggle)
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/audit-test",
      headers: authHeader,
      payload: { enabled: true },
    });

    await waitForAudit();

    // 3. Delete flag
    await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/audit-test",
      headers: authHeader,
    });

    await waitForAudit();

    // Verify: 3 audit events in chronological order
    const events = await queryAudit({ entity: "audit-test" });
    expect(events).toHaveLength(3);

    // Events are returned newest-first (desc order)
    const [deleted, updated, created] = events;

    // Created event
    expect(created.entityType).toBe("flag");
    expect(created.entityKey).toBe("audit-test");
    expect(created.action).toBe("created");
    expect(created.actor).toMatch(/^[0-9a-f]{8}$/);
    expect(created.changes.key).toEqual({ from: null, to: "audit-test" });

    // Updated event — should have enabled change
    expect(updated.action).toBe("updated");
    expect(updated.changes.enabled).toEqual({ from: false, to: true });

    // Deleted event
    expect(deleted.action).toBe("deleted");
    expect(deleted.changes.key).toEqual({ from: "audit-test", to: null });
  });

  it("does not record audit when update has no actual changes", async () => {
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "no-change", name: "No Change", enabled: false },
    });

    await waitForAudit();

    // "Update" with same value — enabled is already false
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/no-change",
      headers: authHeader,
      payload: { enabled: false },
    });

    await waitForAudit();

    const events = await queryAudit({ entity: "no-change" });
    // Only the "created" event — no "updated" because nothing actually changed
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("created");
  });
});

describe("override audit trail", () => {
  beforeEach(async () => {
    // Seed a flag for override tests
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "dark-mode", name: "Dark Mode", enabled: true },
    });
    await waitForAudit();
    // Clear audit so we only see override events
    await db.delete(auditEvents);
  });

  it("records created and deleted events for overrides", async () => {
    // Create override
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
      payload: { enabled: false },
    });

    await waitForAudit();

    // Delete override
    await server.inject({
      method: "DELETE",
      url: "/api/v1/flags/dark-mode/overrides/staging",
      headers: authHeader,
    });

    await waitForAudit();

    const events = await queryAudit({ entity: "dark-mode", entity_type: "override" });
    expect(events).toHaveLength(2);

    const [deleted, created] = events;

    expect(created.action).toBe("created");
    expect(created.entityType).toBe("override");
    expect(created.metadata).toEqual({ environment: "staging" });

    expect(deleted.action).toBe("deleted");
    expect(deleted.metadata).toEqual({ environment: "staging" });
  });

  it("records updated event when override is modified", async () => {
    // Create override
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/production",
      headers: authHeader,
      payload: { enabled: false },
    });

    await waitForAudit();

    // Update override
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/dark-mode/overrides/production",
      headers: authHeader,
      payload: { enabled: true, rolloutPercentage: 50 },
    });

    await waitForAudit();

    const events = await queryAudit({ entity: "dark-mode", entity_type: "override" });
    expect(events).toHaveLength(2);

    const [updated, _created] = events;
    expect(updated.action).toBe("updated");
    expect(updated.changes.enabled).toEqual({ from: false, to: true });
    expect(updated.changes.rolloutPercentage).toEqual({ from: 100, to: 50 });
    expect(updated.metadata).toEqual({ environment: "production" });
  });
});

describe("GET /admin/audit — query filtering", () => {
  beforeEach(async () => {
    // Create two flags to have multiple audit entries
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "flag-a", name: "Flag A" },
    });
    await server.inject({
      method: "POST",
      url: "/api/v1/flags",
      headers: authHeader,
      payload: { key: "flag-b", name: "Flag B" },
    });

    // Update one
    await server.inject({
      method: "PUT",
      url: "/api/v1/flags/flag-a",
      headers: authHeader,
      payload: { enabled: true },
    });

    await waitForAudit();
  });

  it("filters by entity_type", async () => {
    const events = await queryAudit({ entity_type: "flag" });
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.entityType === "flag")).toBe(true);
  });

  it("filters by entity key", async () => {
    const events = await queryAudit({ entity: "flag-a" });
    expect(events).toHaveLength(2); // created + updated
  });

  it("filters by action", async () => {
    const events = await queryAudit({ action: "updated" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.action === "updated")).toBe(true);
  });

  it("filters by actor", async () => {
    const events = await queryAudit({ entity: "flag-a" });
    const actor = events[0].actor;

    const actorEvents = await queryAudit({ actor });
    expect(actorEvents.length).toBeGreaterThan(0);
    expect(actorEvents.every((e) => e.actor === actor)).toBe(true);
  });

  it("supports limit and offset pagination", async () => {
    const page1 = await queryAudit({ limit: "1", offset: "0" });
    expect(page1).toHaveLength(1);

    const page2 = await queryAudit({ limit: "1", offset: "1" });
    expect(page2).toHaveLength(1);

    // Different events on different pages
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("requires auth", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/audit",
    });

    expect(res.statusCode).toBe(401);
  });
});

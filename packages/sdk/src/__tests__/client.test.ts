import { describe, expect, it, vi } from "vitest";
import { FlagKey } from "@project/shared";
import { FlagsmithClient } from "../index.js";

/** Helper: create a mock fetch that returns a given JSON body and status. */
function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

/** Helper: create a mock fetch that rejects with an error. */
function mockFetchError(error: Error): typeof globalThis.fetch {
  return vi.fn().mockRejectedValue(error);
}

const key = FlagKey("dark-mode");

describe("FlagsmithClient.isEnabled", () => {
  it("returns true when flag is enabled", async () => {
    const fetch = mockFetch({
      key: "dark-mode",
      enabled: true,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
    });
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    expect(await client.isEnabled(key)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/v1/evaluate/dark-mode",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when flag is disabled", async () => {
    const fetch = mockFetch({
      key: "dark-mode",
      enabled: false,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
    });
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    expect(await client.isEnabled(key)).toBe(false);
  });

  it("returns false on 404 (safe default)", async () => {
    const fetch = mockFetch({ code: "FLAG_NOT_FOUND" }, 404);
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    expect(await client.isEnabled(key)).toBe(false);
  });

  it("returns false on network error (safe default)", async () => {
    const fetch = mockFetchError(new Error("ECONNREFUSED"));
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    expect(await client.isEnabled(key)).toBe(false);
  });
});

describe("FlagsmithClient.evaluate", () => {
  it("returns full EvaluateResponse on success", async () => {
    const body = {
      key: "dark-mode",
      enabled: true,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      source: "cache" as const,
    };
    const fetch = mockFetch(body);
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    const result = await client.evaluate(key);
    expect(result).toEqual(body);
    expect(result.source).toBe("cache");
  });

  it("throws on 404", async () => {
    const fetch = mockFetch({ code: "FLAG_NOT_FOUND" }, 404);
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    await expect(client.evaluate(key)).rejects.toThrow("Flag evaluation failed: 404");
  });

  it("throws on 500", async () => {
    const fetch = mockFetch({ code: "INTERNAL_ERROR" }, 500);
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch });

    await expect(client.evaluate(key)).rejects.toThrow("Flag evaluation failed: 500");
  });
});

describe("FlagsmithClient configuration", () => {
  it("strips trailing slash from baseUrl", async () => {
    const fetch = mockFetch({
      key: "dark-mode",
      enabled: true,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
    });
    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000/", fetch });

    await client.isEnabled(key);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/v1/evaluate/dark-mode",
      expect.anything(),
    );
  });

  it("uses custom timeout", async () => {
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Simulate that abort fires
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const client = new FlagsmithClient({ baseUrl: "http://localhost:3000", fetch, timeout: 50 });

    await expect(client.isEnabled(key)).resolves.toBe(false); // safe default on timeout
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  getBreaker,
  clearBreakers,
  domainOf,
} from "../../circuit-breaker.js";

// ── domainOf ──────────────────────────────────────────────────────────────

describe("domainOf", () => {
  it("extracts host from URL", () => {
    expect(domainOf("https://api.example.com/webhook")).toBe("api.example.com");
    expect(domainOf("http://localhost:9999/hook")).toBe("localhost:9999");
  });

  it("returns raw string on invalid URL", () => {
    expect(domainOf("not-a-url")).toBe("not-a-url");
  });
});

// ── CircuitBreaker ────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker("test.com", {
      failureThreshold: 3,
      resetTimeout: 100, // Short for testing
    });
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
  });

  it("stays closed on success", async () => {
    await breaker.execute(() => Promise.resolve("ok"));

    expect(breaker.getState()).toBe("closed");
    expect(breaker.getStats().successes).toBe(1);
  });

  it("opens after reaching failure threshold", async () => {
    const fail = () => Promise.reject(new Error("down"));

    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    expect(breaker.getState()).toBe("open");
    expect(breaker.getStats().failures).toBe(3);
  });

  it("throws CircuitOpenError when open", async () => {
    // Force open
    const fail = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    await expect(breaker.execute(() => Promise.resolve("ok"))).rejects.toThrow(CircuitOpenError);
  });

  it("transitions to half-open after resetTimeout", async () => {
    const fail = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    expect(breaker.getState()).toBe("open");

    // Wait for resetTimeout
    await new Promise((r) => setTimeout(r, 120));

    expect(breaker.getState()).toBe("half-open");
  });

  it("closes on success in half-open state", async () => {
    const fail = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    // Wait for half-open
    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.getState()).toBe("half-open");

    // Probe succeeds
    await breaker.execute(() => Promise.resolve("recovered"));
    expect(breaker.getState()).toBe("closed");
  });

  it("reopens on failure in half-open state", async () => {
    const fail = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    // Wait for half-open
    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.getState()).toBe("half-open");

    // Probe fails
    await breaker.execute(fail).catch(() => {});
    expect(breaker.getState()).toBe("open");
  });

  it("resets failure count on success", async () => {
    const fail = () => Promise.reject(new Error("down"));
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    expect(breaker.getStats().failures).toBe(2);

    // One success resets the counter
    await breaker.execute(() => Promise.resolve("ok"));
    expect(breaker.getStats().failures).toBe(0);

    // Need full threshold again to open
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    expect(breaker.getState()).toBe("closed"); // Only 2, need 3
  });

  it("reset() returns to initial state", async () => {
    const fail = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }
    expect(breaker.getState()).toBe("open");

    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getStats().failures).toBe(0);
  });
});

// ── Registry ──────────────────────────────────────────────────────────────

describe("breaker registry", () => {
  beforeEach(() => clearBreakers());

  it("returns same breaker for same domain", () => {
    const b1 = getBreaker("example.com");
    const b2 = getBreaker("example.com");

    expect(b1).toBe(b2);
  });

  it("returns different breakers for different domains", () => {
    const b1 = getBreaker("a.com");
    const b2 = getBreaker("b.com");

    expect(b1).not.toBe(b2);
  });
});

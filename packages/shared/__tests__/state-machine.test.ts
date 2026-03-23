import { describe, expect, it } from "vitest";
import { canTransition, transition, isTerminal, nextStates } from "../state-machine.js";
import type { DeliveryState } from "../index.js";

// ── Valid transitions ────────────────────────────────────────────────────

describe("canTransition", () => {
  it("allows pending → sending", () => {
    expect(canTransition("pending", "sending")).toBe(true);
  });

  it("allows sending → delivered", () => {
    expect(canTransition("sending", "delivered")).toBe(true);
  });

  it("allows sending → retrying", () => {
    expect(canTransition("sending", "retrying")).toBe(true);
  });

  it("allows sending → failed", () => {
    expect(canTransition("sending", "failed")).toBe(true);
  });

  it("allows retrying → sending", () => {
    expect(canTransition("retrying", "sending")).toBe(true);
  });

  it("allows failed → dead", () => {
    expect(canTransition("failed", "dead")).toBe(true);
  });
});

// ── Invalid transitions ──────────────────────────────────────────────────

describe("canTransition rejects invalid transitions", () => {
  it("rejects delivered → sending", () => {
    expect(canTransition("delivered", "sending")).toBe(false);
  });

  it("rejects dead → pending", () => {
    expect(canTransition("dead", "pending")).toBe(false);
  });

  it("rejects pending → delivered (skip sending)", () => {
    expect(canTransition("pending", "delivered")).toBe(false);
  });

  it("rejects pending → dead (skip intermediate states)", () => {
    expect(canTransition("pending", "dead")).toBe(false);
  });

  it("rejects sending → pending (backwards)", () => {
    expect(canTransition("sending", "pending")).toBe(false);
  });

  it("rejects failed → sending (must go through dead)", () => {
    expect(canTransition("failed", "sending")).toBe(false);
  });
});

// ── transition() ─────────────────────────────────────────────────────────

describe("transition", () => {
  it("returns the new state on valid transition", () => {
    expect(transition("pending", "sending")).toBe("sending");
  });

  it("throws on invalid transition", () => {
    expect(() => transition("delivered", "sending")).toThrow(
      "Invalid state transition: delivered → sending",
    );
  });

  it("throws on self-transition for terminal states", () => {
    expect(() => transition("dead", "dead")).toThrow("Invalid state transition: dead → dead");
  });
});

// ── isTerminal ───────────────────────────────────────────────────────────

describe("isTerminal", () => {
  it("delivered is terminal", () => {
    expect(isTerminal("delivered")).toBe(true);
  });

  it("dead is terminal", () => {
    expect(isTerminal("dead")).toBe(true);
  });

  it("pending is not terminal", () => {
    expect(isTerminal("pending")).toBe(false);
  });

  it("sending is not terminal", () => {
    expect(isTerminal("sending")).toBe(false);
  });

  it("retrying is not terminal", () => {
    expect(isTerminal("retrying")).toBe(false);
  });

  it("failed is not terminal", () => {
    expect(isTerminal("failed")).toBe(false);
  });
});

// ── nextStates ───────────────────────────────────────────────────────────

describe("nextStates", () => {
  it("pending can only go to sending", () => {
    expect(nextStates("pending")).toEqual(["sending"]);
  });

  it("sending has three possible next states", () => {
    expect(nextStates("sending")).toEqual(["delivered", "retrying", "failed"]);
  });

  it("terminal states have no next states", () => {
    expect(nextStates("delivered")).toEqual([]);
    expect(nextStates("dead")).toEqual([]);
  });
});

// ── Full lifecycle paths ─────────────────────────────────────────────────

describe("full lifecycle", () => {
  it("happy path: pending → sending → delivered", () => {
    let state: DeliveryState = "pending";
    state = transition(state, "sending");
    state = transition(state, "delivered");
    expect(state).toBe("delivered");
    expect(isTerminal(state)).toBe(true);
  });

  it("retry path: pending → sending → retrying → sending → delivered", () => {
    let state: DeliveryState = "pending";
    state = transition(state, "sending");
    state = transition(state, "retrying");
    state = transition(state, "sending");
    state = transition(state, "delivered");
    expect(state).toBe("delivered");
  });

  it("dead-letter path: pending → sending → failed → dead", () => {
    let state: DeliveryState = "pending";
    state = transition(state, "sending");
    state = transition(state, "failed");
    state = transition(state, "dead");
    expect(state).toBe("dead");
    expect(isTerminal(state)).toBe(true);
  });

  it("multiple retries then success", () => {
    let state: DeliveryState = "pending";
    state = transition(state, "sending");
    state = transition(state, "retrying");
    state = transition(state, "sending");
    state = transition(state, "retrying");
    state = transition(state, "sending");
    state = transition(state, "delivered");
    expect(state).toBe("delivered");
  });

  it("cannot escape terminal state (delivered)", () => {
    const state: DeliveryState = "delivered";
    const allStates: DeliveryState[] = [
      "pending",
      "sending",
      "delivered",
      "failed",
      "retrying",
      "dead",
    ];
    for (const next of allStates) {
      expect(canTransition(state, next)).toBe(false);
    }
  });

  it("cannot escape terminal state (dead)", () => {
    const state: DeliveryState = "dead";
    const allStates: DeliveryState[] = [
      "pending",
      "sending",
      "delivered",
      "failed",
      "retrying",
      "dead",
    ];
    for (const next of allStates) {
      expect(canTransition(state, next)).toBe(false);
    }
  });
});

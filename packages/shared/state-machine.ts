/**
 * Explicit state machine for webhook delivery lifecycle.
 *
 * Every valid transition is declared in the TRANSITIONS map.
 * Anything not listed is a bug — transition() throws immediately.
 * This is the single source of truth: code, tests, and diagrams
 * must all agree with this map.
 *
 * State diagram:
 *
 *   pending → sending → delivered      (happy path)
 *                     → retrying       (5xx / timeout)
 *                     → failed         (4xx / permanent)
 *   retrying → sending                 (retry attempt)
 *   failed → dead                      (max retries exhausted)
 */

import type { DeliveryState } from "./index.js";

const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ["sending"],
  sending: ["delivered", "retrying", "failed"],
  retrying: ["sending"],
  failed: ["dead"],
  delivered: [],
  dead: [],
};

/** Check whether a state transition is allowed. */
export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Perform a state transition. Returns the new state on success.
 * Throws on invalid transitions — this is intentional: invalid
 * transitions are bugs, not recoverable errors.
 */
export function transition(from: DeliveryState, to: DeliveryState): DeliveryState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }

  return to;
}

/** Terminal states have no outgoing transitions. */
export function isTerminal(state: DeliveryState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** All valid next states from a given state. */
export function nextStates(state: DeliveryState): readonly DeliveryState[] {
  return TRANSITIONS[state];
}

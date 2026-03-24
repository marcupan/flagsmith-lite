/**
 * Per-domain circuit breaker for webhook delivery.
 *
 * States:
 *   Closed   — requests pass through normally
 *   Open     — requests fail immediately (fast-fail)
 *   HalfOpen — one probe request allowed; success → close, failure → open
 *
 * One breaker per consumer domain. When a consumer is down, we stop
 * hammering it and give it time to recover.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Milliseconds to wait before transitioning open → half-open. */
  resetTimeout: number;
}

export interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
}

export class CircuitOpenError extends Error {
  constructor(public readonly domain: string) {
    super(`Circuit open for ${domain}`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private readonly config: CircuitBreakerConfig;
  readonly domain: string;

  constructor(domain: string, config: CircuitBreakerConfig) {
    this.domain = domain;
    this.config = config;
  }

  getState(): CircuitState {
    // Check if the open circuit should transition to half-open
    if (this.state === "open" && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;

      if (elapsed >= this.config.resetTimeout) {
        this.state = "half-open";
      }
    }

    return this.state;
  }

  getStats(): CircuitStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * - Closed: execute normally
   * - Open: throw CircuitOpenError immediately
   * - HalfOpen: allow one probe; success closes, failure reopens
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "open") {
      throw new CircuitOpenError(this.domain);
    }

    try {
      const result = await fn();
      this.onSuccess();

      return result;
    } catch (err) {
      this.onFailure();

      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.successes++;

    if (this.state === "half-open") {
      // Probe succeeded — close the circuit
      this.state = "closed";
    }
  }

  private onFailure(): void {
    this.failures++;
    this.successes = 0;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Probe failed — reopen immediately
      this.state = "open";
    } else if (this.failures >= this.config.failureThreshold) {
      this.state = "open";
    }
  }

  /** Force-reset to closed (for testing or manual intervention). */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 30_000,
};

const breakers = new Map<string, CircuitBreaker>();

/** Extract domain from a URL for circuit breaker grouping. */
export function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Get or create a circuit breaker for a consumer domain.
 * All subscriptions pointing to the same domain share one breaker.
 */
export function getBreaker(
  domain: string,
  config: CircuitBreakerConfig = DEFAULT_CONFIG,
): CircuitBreaker {
  let breaker = breakers.get(domain);

  if (!breaker) {
    breaker = new CircuitBreaker(domain, config);
    breakers.set(domain, breaker);
  }

  return breaker;
}

/** Get all registered breakers (for monitoring / runbook diagnostics). */
export function getAllBreakers(): Map<string, CircuitBreaker> {
  return breakers;
}

/** Clear all breakers (for testing). */
export function clearBreakers(): void {
  breakers.clear();
}

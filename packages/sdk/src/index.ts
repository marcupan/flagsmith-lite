import type { EvaluateResponse, FlagKey } from "@project/shared";

/** Configuration for the FlagsmithClient. */
export interface FlagsmithClientOptions {
  /** Base URL of the flagsmith-lite API (e.g. "http://localhost:3000") */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Custom fetch implementation — inject a mock for testing */
  fetch?: typeof globalThis.fetch;
}

/** Options for flag evaluation with targeting context. */
export interface EvaluateOptions {
  /** User identifier for percentage-based targeting. */
  userId?: string;
}

/**
 * Typed SDK client for the flagsmith-lite evaluate API.
 *
 * Designed for external consumers who need a simple, type-safe way to
 * check feature flag state. The client enforces branded FlagKey at the
 * call site — callers must validate keys before passing them in.
 *
 * @example
 * ```ts
 * import { FlagsmithClient } from "@project/sdk";
 * import { FlagKey } from "@project/shared";
 *
 * const client = new FlagsmithClient({ baseUrl: "http://localhost:3000" });
 * const enabled = await client.isEnabled(FlagKey("dark-mode"));
 * ```
 */
export class FlagsmithClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(opts: FlagsmithClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeout = opts.timeout ?? 5000;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /**
   * Evaluate a single flag. Returns `true` if enabled, `false` otherwise.
   *
   * Safe default: returns `false` on any error (network, 404, timeout).
   * This is the standard SDK pattern — feature flags should fail closed.
   *
   * @param key - Flag key to evaluate
   * @param opts - Optional targeting context (userId for percentage rollout)
   */
  async isEnabled(key: FlagKey, opts?: EvaluateOptions): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(this.evaluatePath(key, opts));

      if (!res.ok) {
        return false;
      }

      const body: EvaluateResponse = await res.json();

      return body.enabled;
    } catch {
      return false;
    }
  }

  /**
   * Evaluate a single flag. Returns the full response including source and reason.
   * Throws on non-2xx responses (unlike `isEnabled` which returns false).
   *
   * @param key - Flag key to evaluate
   * @param opts - Optional targeting context (userId for percentage rollout)
   */
  async evaluate(key: FlagKey, opts?: EvaluateOptions): Promise<EvaluateResponse> {
    const res = await this.fetchWithTimeout(this.evaluatePath(key, opts));

    if (!res.ok) {
      throw new Error(`Flag evaluation failed: ${res.status}`);
    }

    return res.json();
  }

  /** Build the evaluate URL path with optional userId query parameter. */
  private evaluatePath(key: FlagKey, opts?: EvaluateOptions): string {
    const base = `/api/v1/evaluate/${key}`;

    if (opts?.userId) {
      return `${base}?userId=${encodeURIComponent(opts.userId)}`;
    }

    return base;
  }

  private async fetchWithTimeout(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

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
   */
  async isEnabled(key: FlagKey): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`/api/v1/evaluate/${key}`);

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
   * Evaluate a single flag. Returns the full response including a source.
   * Throws on non-2xx responses (unlike `isEnabled` which returns false).
   */
  async evaluate(key: FlagKey): Promise<EvaluateResponse> {
    const res = await this.fetchWithTimeout(`/api/v1/evaluate/${key}`);

    if (!res.ok) {
      throw new Error(`Flag evaluation failed: ${res.status}`);
    }

    return res.json();
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

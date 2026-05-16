// Cache interface + InMemoryCache for testing

import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";

export interface Cache {
  get<T>(key: string): Promise<Result<T | null, FrameworkError>>;
  set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>>;
}

export interface InMemoryCacheOpts {
  /** Injectable clock; defaults to `Date.now`. Tests can supply a stub for deterministic TTL assertions. */
  readonly now?: () => number;
}

/** In-memory cache with TTL support — use in tests. */
export class InMemoryCache implements Cache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(opts?: InMemoryCacheOpts) {
    this.now = opts?.now ?? Date.now;
  }

  async get<T>(key: string): Promise<Result<T | null, FrameworkError>> {
    const entry = this.store.get(key);
    if (!entry) return ok(null);
    if (this.now() > entry.expiresAt) {
      this.store.delete(key);
      return ok(null);
    }
    return ok(JSON.parse(entry.value) as T);
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSec * 1000,
    });
    return ok(undefined);
  }
}

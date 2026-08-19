// Cache interface + InMemoryCache for testing

import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import { safeErrorMessage } from "../types/safe-error.js";

const schemaMismatchError = (key: string, message: string): FrameworkError => ({
  kind: "cache-error",
  operation: "get-schema-mismatch",
  message: `key="${key}": ${message}`,
});

export interface Cache {
  /**
   * Get a cached value, validated against the provided schema.
   * Returns `ok(null)` on miss. Returns `err({ kind: "cache-error", operation: "get-schema-mismatch" })`
   * when the key exists but fails schema validation (e.g. after a deploy changes the schema).
   * Callers who want fall-through-to-recompute on drift should match on that specific error.
   */
  get<T>(key: string, schema: z.ZodType<T>): Promise<Result<T | null, FrameworkError>>;
  set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>>;
}

interface InMemoryCacheOpts {
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

  async get<T>(key: string, schema: z.ZodType<T>): Promise<Result<T | null, FrameworkError>> {
    const entry = this.store.get(key);
    if (!entry) return ok(null);
    // The clock is a hostile seam: a throwing clock must surface as a typed
    // cache-error, never a raw rejection, and a non-finite now must not make
    // the TTL comparison silently meaningless.
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch (e) {
      return err({ kind: "cache-error", operation: "get", message: `key="${key}": clock failed: ${safeErrorMessage(e)}` });
    }
    if (!Number.isFinite(nowMs) || nowMs > entry.expiresAt) {
      this.store.delete(key);
      return ok(null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.value);
    } catch (e) {
      const message = `key="${key}": JSON.parse failed: ${safeErrorMessage(e)}`;
      return err({ kind: "cache-error", operation: "get", message });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) return err(schemaMismatchError(key, validated.error.message));
    return ok(validated.data);
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>> {
    // Mirror `get`'s guard: serialization and the clock are hostile seams and
    // `set` documents `Result<void, FrameworkError>` — a cyclic value or a
    // throwing clock must be a typed cache-error, never a raw rejection.
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return err({ kind: "cache-error", operation: "set", message: `key="${key}": JSON.stringify failed: ${safeErrorMessage(e)}` });
    }
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch (e) {
      return err({ kind: "cache-error", operation: "set", message: `key="${key}": clock failed: ${safeErrorMessage(e)}` });
    }
    if (!Number.isFinite(nowMs)) {
      return err({ kind: "cache-error", operation: "set", message: `key="${key}": clock returned a non-finite timestamp` });
    }
    this.store.set(key, {
      value: json,
      expiresAt: nowMs + ttlSec * 1000,
    });
    return ok(undefined);
  }
}
